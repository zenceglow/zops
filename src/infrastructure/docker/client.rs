use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use bollard::container::{
    InspectContainerOptions, ListContainersOptions, LogsOptions, RemoveContainerOptions,
    MemoryStatsStats, Stats, StatsOptions, StopContainerOptions,
};
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::future::join_all;
use futures_util::StreamExt;

/// bollard 的默认超时是私有的，这里自己给一个：容器列表/日志都是短请求。
const DOCKER_TIMEOUT_SECS: u64 = 30;

use crate::domain::container::ContainerDto;
use crate::shared::AppError;

/// Docker 的完整 id 是 64 位，面板上只用到前 12 位（docker CLI 的惯例）。
///
/// 用 get 而不是 `[..12]`：那样在 id 缺失或异常短时会直接 panic，把一个列表
/// 请求变成 500。
fn short_id(id: &str) -> String {
    id.get(..12).unwrap_or(id).to_string()
}

/// 一个容器的实时占用。取不到就是 None，调用方据此整块不显示。
#[derive(Default)]
struct Usage {
    cpu_percent: Option<f64>,
    mem_used: Option<u64>,
    mem_limit: Option<u64>,
}

/// 一次 CPU 采样的基准值。
///
/// Docker one-shot 接口返回的 `precpu_stats` 是**全零**（没有前值可给），所以差值
/// 只能自己攒：把上一次请求的读数存下来，跟这一次相减。
#[derive(Clone, Copy)]
struct CpuSample {
    /// 容器累计消耗的 CPU 时间（纳秒）。
    total_usage: u64,
    /// 系统累计的 CPU 时间（所有核加总）。
    system_usage: u64,
    cores: u64,
}

/// 首次请求没有基准可减，隔一小会儿补采一次。
///
/// Docker 侧的统计按秒推进，间隔太短会拿到 0 差值，所以给足一秒。只在进程刚起
/// （或容器刚起）后的第一个请求里发生，之后都走上次留下的样本。
const PRIME_GAP: Duration = Duration::from_millis(1000);

fn cpu_sample(s: &Stats) -> Option<CpuSample> {
    let cpu = &s.cpu_stats;
    let cores = cpu
        .online_cpus
        .filter(|n| *n > 0)
        .or_else(|| cpu.cpu_usage.percpu_usage.as_ref().map(|v| v.len() as u64))
        .unwrap_or(1);
    Some(CpuSample {
        total_usage: cpu.cpu_usage.total_usage,
        system_usage: cpu.system_cpu_usage?,
        cores,
    })
}

/// CPU 占用百分比（单核口径：100% = 占满一个核）。
///
/// 跟 top 一个算法：容器在这段时间里用掉的 CPU 时间 ÷ 系统同时段的总 CPU 时间
/// × 核数。有 n 个核时，容器跑满全部核心会到 n×100%，这正是 `docker stats` 的口径。
fn cpu_percent_between(prev: &CpuSample, cur: &CpuSample) -> Option<f64> {
    let used_delta = cur.total_usage.saturating_sub(prev.total_usage) as f64;
    let sys_delta = cur.system_usage.saturating_sub(prev.system_usage) as f64;
    // 只有分母没意义时才算未知。分子为 0 是**合法**的 —— 一个闲着的 redis 在
    // 这段窗口里可能真的一点 CPU 都没用，那是 0%，不是"取不到"。
    if sys_delta <= 0.0 {
        return None;
    }
    Some(used_delta / sys_delta * cur.cores as f64 * 100.0)
}

/// 实际内存占用。
///
/// cgroup 把 page cache 也算进 usage，直接显示会看到"一个闲着的 nginx 吃了 800MB"。
/// 所以要减掉缓存 —— 但 cgroup v1/v2 的键名不一样（v2 是 inactive_file），
/// 两个都试一遍，都没有就只好不减。
fn mem_usage(s: &Stats) -> (Option<u64>, Option<u64>) {
    let m = &s.memory_stats;
    let Some(usage) = m.usage else {
        return (None, None);
    };
    let cache = match m.stats.as_ref() {
        Some(MemoryStatsStats::V2(v2)) => v2.inactive_file,
        Some(MemoryStatsStats::V1(v1)) => v1.total_inactive_file,
        None => 0,
    };
    // 缓存可能比 usage 还离谱（统计口径切换时见过），兜个底别让数字变负数。
    (Some(usage.saturating_sub(cache)), m.limit)
}

pub struct DockerClient {
    docker: Option<Docker>,
    /// 上一次的 CPU 读数，按容器 id 存。只在读时短暂加锁，不跨 await 持有。
    cpu_samples: Mutex<HashMap<String, CpuSample>>,
}

impl DockerClient {
    pub fn connect() -> Self {
        Self {
            docker: Self::build_client(),
            cpu_samples: Mutex::new(HashMap::new()),
        }
    }

    /// 解析 Docker 端点并建连。
    ///
    /// 不用 `connect_with_local_defaults()`：它只认 `DOCKER_HOST` 和
    /// `/var/run/docker.sock`。macOS 上的 Docker Desktop 把 socket 放在
    /// `~/.docker/run/docker.sock`（context = desktop-linux），于是本地开发时
    /// `docker info` 一切正常、面板却报「Docker 不可用」——两边看的是不同端点。
    /// 这里改成先问 CLI 当前 context 用的是哪个 Host，再退回常见路径。
    fn build_client() -> Option<Docker> {
        for endpoint in Self::candidate_endpoints() {
            // 不存在的 socket 直接跳过：connect_with_socket 只构造客户端、
            // 不做 I/O，不先判存在性的话第一个候选永远"成功"，后面全是白试。
            if let Some(path) = endpoint.strip_prefix("unix://") {
                if !std::path::Path::new(path).exists() {
                    continue;
                }
            }
            if let Some(docker) = Self::connect_endpoint(&endpoint) {
                return Some(docker);
            }
        }
        Docker::connect_with_local_defaults().ok()
    }

    fn candidate_endpoints() -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Ok(host) = std::env::var("DOCKER_HOST") {
            let host = host.trim().to_string();
            if !host.is_empty() {
                out.push(host);
            }
        }
        if let Ok(o) = std::process::Command::new("docker")
            .args(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
            .output()
        {
            if o.status.success() {
                let host = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if !host.is_empty() && !host.starts_with('<') {
                    out.push(host);
                }
            }
        }
        out.push("unix:///var/run/docker.sock".to_string());
        if let Some(home) = std::env::var_os("HOME") {
            out.push(format!(
                "unix://{}",
                std::path::Path::new(&home).join(".docker/run/docker.sock").display()
            ));
        }
        out.dedup();
        out
    }

    fn connect_endpoint(endpoint: &str) -> Option<Docker> {
        let timeout = DOCKER_TIMEOUT_SECS;
        if endpoint.starts_with("tcp://")
            || endpoint.starts_with("http://")
            || endpoint.starts_with("https://")
        {
            Docker::connect_with_http(endpoint, timeout, API_DEFAULT_VERSION).ok()
        } else {
            // unix:// 与裸路径都走 socket（bollard 自己会去掉 scheme）
            Docker::connect_with_socket(endpoint, timeout, API_DEFAULT_VERSION).ok()
        }
    }

    pub fn is_available() -> bool {
        let binary_found = std::process::Command::new("which")
            .arg("docker")
            .output()
            .ok()
            .map(|o| !o.stdout.is_empty())
            .unwrap_or(false);

        if !binary_found {
            return false;
        }

        std::process::Command::new("docker")
            .args(["info", "--format", "{{.ServerVersion}}"])
            .output()
            .ok()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn version() -> String {
        if !Self::is_available() {
            return String::new();
        }
        std::process::Command::new("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string()))
            .unwrap_or_default()
    }

    fn docker(&self) -> Result<&Docker, AppError> {
        self.docker
            .as_ref()
            .ok_or_else(|| AppError::bad_gateway("Docker 不可用"))
    }

    async fn read_stats(docker: &Docker, id: &str) -> Option<Stats> {
        docker
            .stats(id, Some(StatsOptions { stream: false, one_shot: true }))
            .next()
            .await
            .and_then(Result::ok)
    }

    /// 一个容器的即时占用。
    async fn container_usage(&self, docker: &Docker, id: &str, running: bool) -> Usage {
        // 停掉的容器查 stats 只会报错，不必白跑一趟；顺手把基准也清掉，免得它
        // 重新启动后拿一段跨越停机时间的差，算出个离谱的平均值。
        if !running {
            self.cpu_samples.lock().unwrap().remove(id);
            return Usage::default();
        }

        let Some(first) = Self::read_stats(docker, id).await else {
            return Usage::default();
        };
        let (mem_used, mem_limit) = mem_usage(&first);

        let cur = cpu_sample(&first);
        let prev = cur.and_then(|c| self.cpu_samples.lock().unwrap().insert(id.to_string(), c));

        let cpu_percent = match (prev, cur) {
            (Some(prev), Some(cur)) => cpu_percent_between(&prev, &cur),
            // 没有基准（进程刚起、或容器刚启动）：现场补采一次，别让首帧空着。
            _ => {
                tokio::time::sleep(PRIME_GAP).await;
                let next = match Self::read_stats(docker, id).await {
                    Some(s) => cpu_sample(&s),
                    None => None,
                };
                if let Some(next) = next {
                    self.cpu_samples.lock().unwrap().insert(id.to_string(), next);
                }
                match (cur, next) {
                    (Some(a), Some(b)) => cpu_percent_between(&a, &b),
                    _ => None,
                }
            }
        };

        Usage { cpu_percent, mem_used, mem_limit }
    }

    pub async fn list_containers(&self) -> Result<Vec<ContainerDto>, AppError> {
        let docker = self.docker()?;
        let options = ListContainersOptions::<String> {
            all: true,
            ..Default::default()
        };
        let containers = docker
            .list_containers(Some(options))
            .await
            .map_err(|_| AppError::internal("操作失败"))?;

        // 每个容器还要额外问 Docker 两次（inspect 拿启动时刻、stats 拿占用）。
        // 串行做的话容器一多就明显卡在列表接口上；并发跑，总耗时约等于最慢的一个。
        // 单条失败不影响整体：拿不到就当未知。
        let out = join_all(containers.into_iter().map(|c| {
            let docker = docker.clone();
            async move {
                let raw_id = c.id.unwrap_or_default();
                let state = c.state.unwrap_or_default();

                let started_at = docker
                    .inspect_container(&raw_id, None::<InspectContainerOptions>)
                    .await
                    .ok()
                    .and_then(|i| i.state.and_then(|s| s.started_at))
                    .unwrap_or_default();
                let usage = self.container_usage(&docker, &raw_id, state == "running").await;

                ContainerDto {
                    id: short_id(&raw_id),
                    name: c
                        .names
                        .unwrap_or_default()
                        .first()
                        .cloned()
                        .unwrap_or_default()
                        .trim_start_matches('/')
                        .to_string(),
                    image: c.image.unwrap_or_default(),
                    status: c.status.unwrap_or_default(),
                    state,
                    ports: c
                        .ports
                        .unwrap_or_default()
                        .iter()
                        .map(|p| {
                            format!(
                                "{}:{}-{}",
                                p.ip.as_deref().unwrap_or("0.0.0.0"),
                                p.public_port.unwrap_or(0),
                                p.private_port
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", "),
                    started_at,
                    cpu_percent: usage.cpu_percent,
                    mem_used: usage.mem_used,
                    mem_limit: usage.mem_limit,
                }
            }
        }))
        .await;

        Ok(out)
    }

    pub async fn start(&self, id: &str) -> Result<(), AppError> {
        self.docker()?
            .start_container::<String>(id, None)
            .await
            .map_err(|_| AppError::internal("操作失败"))
    }

    pub async fn stop(&self, id: &str) -> Result<(), AppError> {
        self.docker()?
            .stop_container(id, None::<StopContainerOptions>)
            .await
            .map_err(|_| AppError::internal("操作失败"))
    }

    pub async fn restart(&self, id: &str) -> Result<(), AppError> {
        self.docker()?
            .restart_container(id, None)
            .await
            .map_err(|_| AppError::internal("操作失败"))
    }

    pub async fn remove(&self, id: &str) -> Result<(), AppError> {
        self.docker()?
            .remove_container(id, None::<RemoveContainerOptions>)
            .await
            .map_err(|_| AppError::internal("操作失败"))
    }

    pub async fn logs(&self, id: &str, tail: usize) -> Result<Vec<String>, AppError> {
        let docker = self.docker()?;
        let options = LogsOptions::<String> {
            stdout: true,
            stderr: true,
            tail: tail.to_string(),
            ..Default::default()
        };
        let mut stream = docker.logs(id, Some(options));
        let mut lines: Vec<String> = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(output) => lines.push(output.to_string()),
                Err(_) => break,
            }
        }
        Ok(lines)
    }
}
