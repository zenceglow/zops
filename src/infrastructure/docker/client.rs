use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use bollard::image::{ListImagesOptions, PruneImagesOptions};
use bollard::network::ListNetworksOptions;
use bollard::container::{
    InspectContainerOptions, ListContainersOptions, LogsOptions, RemoveContainerOptions,
    MemoryStatsStats, Stats, StatsOptions, StopContainerOptions,
};
use bollard::models::PortMap;
use bollard::{Docker, API_DEFAULT_VERSION};
use futures_util::future::join_all;
use futures_util::StreamExt;

/// bollard 的默认超时是私有的，这里自己给一个：容器列表/日志都是短请求。
const DOCKER_TIMEOUT_SECS: u64 = 30;

use crate::domain::container::{ContainerDto, DockerInfo, ImageDto, ImageList, NetworkDto, NetworkList};

/// 跑一条 docker CLI 命令并拿回 stdout。
///
/// `docker info --format '{{json .}}'` 这种活儿交给 CLI 比用 bollard 的类型化结构
/// 再手工转 JSON 稳得多：字段是 Docker 自己维护的，我们不用跟着它的版本改代码。
fn docker_cli(args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("docker").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
use crate::shared::AppError;

/// Docker 的完整 id 是 64 位，面板上只用到前 12 位（docker CLI 的惯例）。
///
/// 用 get 而不是 `[..12]`：那样在 id 缺失或异常短时会直接 panic，把一个列表
/// 请求变成 500。
fn short_id(id: &str) -> String {
    id.get(..12).unwrap_or(id).to_string()
}

/// 清理垃圾时"要清哪些"。
///
/// `images` 只删悬空镜像；`unused_images` 是 `docker image prune -a` 那一档 ——
/// 带 tag 但没有任何容器引用（**包含回滚用的备份 tag**，所以默认不勾）。
/// `build_cache` 是每次构建都会长大、删了容器也不会自己消失的构建缓存，
/// bollard 这一版没有它的 prune 接口，只能走 CLI。
///
/// 卷不在里面：卷里是数据，"没在使用"不等于"可以删"。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PruneRequest {
    pub containers: bool,
    pub images: bool,
    pub networks: bool,
    #[serde(default)]
    pub unused_images: bool,
    #[serde(default)]
    pub build_cache: bool,
}

/// 各项删掉的数量 + 合计释放的空间。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PruneResult {
    pub containers: i64,
    pub images: i64,
    pub networks: i64,
    pub unused_images: i64,
    pub build_cache: i64,
    pub bytes: i64,
}

/// 一类可清理的东西：有几项、大概能释放多少。
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct JunkItem {
    pub count: i64,
    pub bytes: i64,
}

#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct JunkSummary {
    pub images: JunkItem,
    pub containers: JunkItem,
    pub networks: JunkItem,
    pub unused_images: JunkItem,
    pub build_cache: JunkItem,
}

/// `docker system df` 那种人读大小：`23.33MB`、`1.2 GB`、`0B`、`512kB`。
///
/// 只解析开头的数字 + 单位，后面的 `(7%)` 直接忽略。
fn parse_human_size(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let split = s
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let value: f64 = num.trim().parse().ok()?;
    let mult: f64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1.0,
        "kb" | "kib" => 1024.0,
        "mb" | "mib" => 1024.0 * 1024.0,
        "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * mult) as i64)
}

/// 构建缓存有多少可以回收。
///
/// 为什么走 CLI：BuildKit 的缓存不在 Docker 的 HTTP API 里（走 gRPC），
/// bollard 这一版既没有 df 口径的可回收字节，也没有 prune 接口；
/// `docker system df --format json` 是唯一稳定、带机读字段的来源。
/// 读不到就当 0：**少报**比"报了一堆其实清不掉"好。
fn build_cache_junk() -> JunkItem {
    let out = match std::process::Command::new("docker")
        .args(["system", "df", "--format", "json"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return JunkItem::default(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("Type").and_then(|t| t.as_str()) != Some("Build Cache") {
            continue;
        }
        let count = v
            .get("TotalCount")
            .and_then(|c| c.as_str())
            .and_then(|c| c.parse::<i64>().ok())
            .unwrap_or(0);
        let bytes = v
            .get("Reclaimable")
            .and_then(|r| r.as_str())
            .and_then(parse_human_size)
            .unwrap_or(0);
        return JunkItem { count, bytes };
    }
    JunkItem::default()
}

/// 端口映射的线上格式：`宿主ip:宿主端口-容器端口`，多条用逗号分隔。
///
/// 只声明、没映射到宿主端口的写成 `0.0.0.0:0-容器端口`，前端会跳过宿主端口为 0
/// 的那些。**改动这个格式要连前端 `shortPorts` 一起改**。
fn format_port(host_ip: Option<&str>, host_port: u16, container_port: u16) -> String {
    format!("{}:{}-{}", host_ip.unwrap_or("0.0.0.0"), host_port, container_port)
}

/// 从 inspect 里取端口映射。
///
/// 不用列表接口的 `Ports`：Docker 那边对老容器会**间歇性报错宿主端口** —— 本机
/// 实测同一个容器连查四次，同一个字段在 3306 和 3307 之间跳（这两台端口分别属于
/// 两个不同容器），而 inspect 四次都是稳定的。面板显示的"两个 mysql 都占 3307"
/// 就是这么来的。
fn ports_from_inspect(ports: &PortMap) -> String {
    let mut rows: Vec<(u16, String)> = Vec::new();
    for (key, bindings) in ports {
        // key 形如 "3306/tcp"
        let Some(container_port) = key
            .split('/')
            .next()
            .and_then(|p| p.parse::<u16>().ok())
        else {
            continue;
        };
        match bindings {
            Some(list) if !list.is_empty() => {
                for b in list {
                    let host_port = b
                        .host_port
                        .as_deref()
                        .and_then(|p| p.parse::<u16>().ok())
                        .unwrap_or(0);
                    rows.push((
                        container_port,
                        format_port(b.host_ip.as_deref(), host_port, container_port),
                    ));
                }
            }
            // 没有绑定 = 只在容器网络里可达，宿主上连不到。
            _ => rows.push((container_port, format_port(None, 0, container_port))),
        }
    }
    // HashMap 的顺序是随机的，排一下，免得面板每次刷新端口顺序都在变。
    rows.sort_by_key(|(port, _)| *port);
    rows.into_iter().map(|(_, s)| s).collect::<Vec<_>>().join(", ")
}

/// inspect 拿不到时的退路：用列表接口给的那份（可能带上面说的错值）。
fn ports_from_summary(c: &bollard::models::ContainerSummary) -> String {
    c.ports
        .as_ref()
        .map(|ports| {
            ports
                .iter()
                .map(|p| format_port(p.ip.as_deref(), p.public_port.unwrap_or(0), p.private_port))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
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
                let raw_id = c.id.clone().unwrap_or_default();
                let state = c.state.clone().unwrap_or_default();

                let inspect = docker
                    .inspect_container(&raw_id, None::<InspectContainerOptions>)
                    .await
                    .ok();
                let started_at = inspect
                    .as_ref()
                    .and_then(|i| i.state.as_ref())
                    .and_then(|s| s.started_at.clone())
                    .unwrap_or_default();
                let ports = inspect
                    .as_ref()
                    .and_then(|i| i.network_settings.as_ref())
                    .and_then(|n| n.ports.as_ref())
                    .map(ports_from_inspect)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| ports_from_summary(&c));
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
                    ports,
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

    /// 镜像列表。带 tag 的和悬空的都要 —— 悬空的正是"垃圾"那一类，
    /// 不列出来用户根本不知道有它们的
    pub async fn list_images(&self) -> Result<ImageList, AppError> {
        let docker = self.docker()?;
        let options = ListImagesOptions::<String> {
            all: true,
            ..Default::default()
        };
        let images = docker
            .list_images(Some(options))
            .await
            .map_err(|_| AppError::internal("读取镜像列表失败"))?;

        let mut out: Vec<ImageDto> = images
            .into_iter()
            .map(|i| {
                // `<none>:<none>` 是 Docker 给悬空镜像的占位，别当成真 tag 显示。
                let tags: Vec<String> = i
                    .repo_tags
                    .into_iter()
                    .filter(|t| t != "<none>:<none>" && !t.is_empty())
                    .collect();
                let dangling = i.repo_digests.is_empty() && tags.is_empty();
                ImageDto {
                    id: short_id(&i.id),
                    dangling,
                    tags,
                    size: i.size.max(0) as u64,
                    created: i.created,
                    containers: i.containers,
                }
            })
            .collect();
        // 大的排前面：要找的就是"谁占着我的盘"。
        out.sort_by(|a, b| b.size.cmp(&a.size));

        let dangling_size = out.iter().filter(|i| i.dangling).map(|i| i.size).sum();
        Ok(ImageList {
            images: out,
            dangling_size,
        })
    }

    pub async fn list_networks(&self) -> Result<NetworkList, AppError> {
        let docker = self.docker()?;
        let networks = docker
            .list_networks(None::<ListNetworksOptions<String>>)
            .await
            .map_err(|_| AppError::internal("读取网络列表失败"))?;

        // 列表接口不带"哪些容器挂在上面"，得逐个 inspect。网络一般就几个，并发问一遍
        // 比让用户自己再去翻快得多；单个失败就当 0。
        let mut out: Vec<NetworkDto> = join_all(networks.into_iter().map(|n| {
            let docker = docker.clone();
            async move {
                let id = n.id.clone().unwrap_or_default();
                let containers = docker
                    .inspect_network(&id, None::<bollard::network::InspectNetworkOptions<String>>)
                    .await
                    .ok()
                    .and_then(|d| d.containers)
                    .map(|c| c.len())
                    .unwrap_or(0);
                NetworkDto {
                    id: short_id(&id),
                    name: n.name.unwrap_or_default(),
                    driver: n.driver.unwrap_or_default(),
                    scope: n.scope.unwrap_or_default(),
                    internal: n.internal.unwrap_or(false),
                    containers,
                    subnet: n
                        .ipam
                        .and_then(|i| i.config)
                        // ipam.config 是一个网络的地址池列表，取第一个（多池的很少见）。
                        .and_then(|c| c.into_iter().find_map(|c| c.subnet))
                        .unwrap_or_default(),
                }
            }
        }))
        .await;
        // 默认网络排最后：那是 Docker 自己建的，不是用户要管的。
        out.sort_by_key(|n| (n.name == "bridge" || n.name == "host" || n.name == "none", n.name.clone()));
        Ok(NetworkList { networks: out })
    }

    /// Docker 引擎自己的配置。
    ///
    /// 走 CLI 拿原始 JSON，不用 bollard 的类型化结构再手工转换 —— 前者字段由
    /// Docker 自己维护，我们不用跟着它的版本改代码；后者漏一个字段就是"面板上看
    /// 不到这条配置"。
    pub async fn info(&self) -> DockerInfo {
        let parse = |raw: Option<String>| -> serde_json::Value {
            raw.and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(serde_json::Value::Null)
        };
        let info = tokio::task::spawn_blocking(|| docker_cli(&["info", "--format", "{{json .}}"]))
            .await
            .ok()
            .flatten();
        let version =
            tokio::task::spawn_blocking(|| docker_cli(&["version", "--format", "{{json .}}"]))
                .await
                .ok()
                .flatten();
        DockerInfo {
            available: info.is_some(),
            info: parse(info),
            version: parse(version),
        }
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

    /// 清理垃圾，返回各项释放的字节数。
    ///
    /// 只做"没人还在用"的东西：悬空镜像（没标签、没容器引用）、已停止容器、没有
    /// 容器接入的网络。**刻意不动卷** —— 卷里是数据，"没在使用"和"可以删"是两回事。
    ///
    /// 每项都单独返回释放量，因为 Docker 给的就是这个数：做完能说出"清了 1.2 GB"，
    /// 比一句"清理完成"有意义得多。
    pub async fn prune(&self, what: &PruneRequest) -> Result<PruneResult, AppError> {
        let docker = self.docker()?;
        let mut result = PruneResult::default();

        if what.containers {
            let r = docker
                .prune_containers(None::<bollard::container::PruneContainersOptions<String>>)
                .await
                .map_err(|_| AppError::internal("清理已停止容器失败"))?;
            result.containers = r.containers_deleted.map(|v| v.len() as i64).unwrap_or(0);
            result.bytes += r.space_reclaimed.unwrap_or(0);
        }
        if what.images {
            let r = docker
                .prune_images(Some(PruneImagesOptions::<String> {
                    // dangling=true：只删悬空镜像。不加这个会把所有没在跑的镜像
                    // 都算进去（包括 next 部署要用的那个），那是事故不是清理。
                    filters: std::collections::HashMap::from([(
                        "dangling".to_string(),
                        vec!["true".to_string()],
                    )]),
                }))
                .await
                .map_err(|_| AppError::internal("清理悬空镜像失败"))?;
            result.images = r.images_deleted.map(|v| v.len() as i64).unwrap_or(0);
            result.bytes += r.space_reclaimed.unwrap_or(0);
        }
        if what.networks {
            let r = docker
                .prune_networks(None::<bollard::network::PruneNetworksOptions<String>>)
                .await
                .map_err(|_| AppError::internal("清理未使用网络失败"))?;
            result.networks = r.networks_deleted.map(|v| v.len() as i64).unwrap_or(0);
        }
        if what.unused_images {
            // dangling=false 就是 `docker image prune -a`：把没被任何容器引用的镜像
            // （**包括带着 tag 的**）一起收掉。这正是"容器删了、镜像还在"的那个垃圾。
            let r = docker
                .prune_images(Some(PruneImagesOptions::<String> {
                    filters: std::collections::HashMap::from([(
                        "dangling".to_string(),
                        vec!["false".to_string()],
                    )]),
                }))
                .await
                .map_err(|_| AppError::internal("清理未使用镜像失败"))?;
            result.unused_images = r.images_deleted.map(|v| v.len() as i64).unwrap_or(0);
            result.bytes += r.space_reclaimed.unwrap_or(0);
        }
        if what.build_cache {
            // 构建缓存没有 HTTP 接口（BuildKit 走 gRPC），只能叫 CLI 干活。
            // `-a` 连"正在用"的也一起清，`-f` 免掉交互确认。
            let out = std::process::Command::new("docker")
                .args(["builder", "prune", "-af"])
                .output()
                .map_err(|e| AppError::internal(format!("调用 docker builder prune 失败：{e}")))?;
            if !out.status.success() {
                return Err(AppError::internal(format!(
                    "清理构建缓存失败：{}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )));
            }
            let text = String::from_utf8_lossy(&out.stdout);
            result.build_cache = 1;
            result.bytes += text
                .lines()
                .rev()
                .find_map(|l| l.trim().strip_prefix("Total:").map(str::trim))
                .and_then(parse_human_size)
                .unwrap_or(0);
        }
        Ok(result)
    }

    /// 扫一遍"有多少垃圾可清"。
    ///
    /// 口径必须和 `prune` 一致，否则弹窗说"可释放 2.1 GB"、点完只放出 300 MB，
    /// 用户下次就不信这个数了：镜像只算**悬空**的（没标签也没被引用），容器只算
    /// 已经停掉的，网络只算除 docker 自带的 bridge/host/none 之外、没容器接入的。
    pub async fn junk_summary(&self) -> Result<JunkSummary, AppError> {
        let docker = self.docker()?;
        let mut out = JunkSummary::default();

        if let Ok(images) = docker
            .list_images(None::<bollard::image::ListImagesOptions<String>>)
            .await
        {
            for img in images {
                // 悬空镜像的 repo_tags 是空的，或者只剩 <none>:<none>。
                let dangling = img.repo_tags.is_empty()
                    || img
                        .repo_tags
                        .iter()
                        .all(|t| t.starts_with("<none>"));
                if dangling {
                    out.images.count += 1;
                    // size 里含与其他镜像共享的层，减掉才是真正能回收的。
                    out.images.bytes += (img.size - img.shared_size).max(0);
                } else if img.containers == -1 {
                    // 有 tag、但没有任何容器引用（running/stopped 都算）——
                    // 这就是 `docker image prune -a` 会收走的部分。
                    out.unused_images.count += 1;
                    out.unused_images.bytes += (img.size - img.shared_size).max(0);
                }
            }
        }

        if let Ok(list) = docker
            .list_containers(Some(ListContainersOptions::<String> {
                all: true,
                ..Default::default()
            }))
            .await
        {
            for c in list {
                if c.state.as_deref() != Some("running") {
                    out.containers.count += 1;
                    out.containers.bytes += c.size_rw.unwrap_or(0).max(0);
                }
            }
        }

        if let Ok(list) = docker
            .list_networks(None::<bollard::network::ListNetworksOptions<String>>)
            .await
        {
            for n in list {
                let name = n.name.unwrap_or_default();
                // bridge / host / none 是 dockerd 自己建的，prune 也不会碰它们。
                if matches!(name.as_str(), "bridge" | "host" | "none") {
                    continue;
                }
                // 必须逐个 inspect：**列表接口不返回网络里挂了哪些容器**，那个字段
                // 一直是空的。只看列表的话，所有 compose 网络都会被算成"没在使用"
                // —— 实测报出 6 个，而实际上它们各自都接着容器。
                let in_use = docker
                    .inspect_network(&name, None::<bollard::network::InspectNetworkOptions<String>>)
                    .await
                    .ok()
                    .and_then(|d| d.containers)
                    .map(|c| !c.is_empty())
                    .unwrap_or(true); // 查不到就当在用，宁可少清也不要清错
                if !in_use {
                    out.networks.count += 1;
                }
            }
        }

        out.build_cache = build_cache_junk();

        Ok(out)
    }

    pub async fn restart(&self, id: &str) -> Result<(), AppError> {
        self.docker()?
            .restart_container(id, None)
            .await
            .map_err(|_| AppError::internal("操作失败"))
    }

    /// 删容器。`force: true` 会先 kill 再删 —— 界面上的删除按钮已经二次确认过
    /// （"容器里没挂到卷上的数据会一起消失"），不带 force 的话运行中的容器一律
    /// 删不掉，用户只会看到一句"操作失败"。
    pub async fn remove(&self, id: &str, force: bool) -> Result<(), AppError> {
        self.docker()?
            .remove_container(
                id,
                Some(RemoveContainerOptions {
                    force,
                    ..Default::default()
                }),
            )
            .await
            // 把 Docker 的原话带出来：以前统一写"操作失败"，出问题时看不出是
            // 没权限、容器在用、还是名字不对。
            .map_err(|e| AppError::internal(format!("删除容器失败：{e}")))
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
                Err(e) => {
                    // 一条都没读到就报错 = 容器不存在 / 引擎拒绝。以前这里直接 break，
                    // 调用方拿到的是"空日志"，看起来像"容器在、只是没输出" —— 排障时
                    // 最坑人的那种假信息。读了一半才断的（日志被轮转等）才当截断。
                    if lines.is_empty() {
                        return Err(AppError::not_found(format!("读取容器日志失败：{e}")));
                    }
                    break;
                }
            }
        }
        Ok(lines)
    }

    /// 删一个镜像。
    ///
    /// 走 CLI 而不是 bollard：删不掉的时候 dockerd 会明确说"被某个容器用着"，
    /// bollard 的 remove_image 只会丢出一个 409，用户看到的就是"操作失败"。
    pub async fn remove_image(&self, reference: &str, force: bool) -> Result<String, AppError> {
        let reference = reference.to_string();
        tokio::task::spawn_blocking(move || {
            let mut args: Vec<&str> = vec!["image", "rm"];
            if force {
                args.push("-f");
            }
            args.push(&reference);
            let out = std::process::Command::new("docker")
                .args(&args)
                .output()
                .map_err(|e| AppError::internal(format!("调不动 docker：{e}")))?;
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
                return Err(AppError::bad_request(if err.is_empty() {
                    stdout
                } else {
                    err
                }));
            }
            Ok(stdout)
        })
        .await
        .map_err(|e| AppError::internal(format!("删除任务没能启动：{e}")))?
    }

    /// 引擎配置文件的路径。默认 `/etc/docker/daemon.json`，本地开发可以指别处。
    pub fn daemon_path() -> std::path::PathBuf {
        std::env::var("OPS_DOCKER_DAEMON_JSON")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("/etc/docker/daemon.json"))
    }

    /// 读引擎配置。文件不存在不是错误 —— 全新装的 Docker 就没有这个文件，
    /// 那时候界面该给一个空表单让人填镜像加速器，而不是报错。
    pub fn daemon_read() -> crate::domain::container::DaemonFile {
        use crate::domain::container::DaemonFile;

        let path = Self::daemon_path();
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap_or_default();
        let list = |key: &str| -> Vec<String> {
            parsed
                .get(key)
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };

        DaemonFile {
            path: path.display().to_string(),
            exists: path.exists(),
            content,
            can_write: can_write(&path),
            mirrors: list("registry-mirrors"),
            insecure_registries: list("insecure-registries"),
        }
    }

    /// 写引擎配置：校验 → 备份 → 原子写 → 重启 docker。
    ///
    /// 顺序不能反。daemon.json 少一个逗号，dockerd 就起不来 —— 而一台机器上所有
    /// 容器都跟着停在那一刻。所以先解析一遍 JSON，再把老文件备份走，最后才落盘。
    pub async fn daemon_write(
        &self,
        content: &str,
    ) -> Result<crate::domain::container::DaemonWriteResult, AppError> {
        use crate::domain::container::DaemonWriteResult;

        let path = Self::daemon_path();
        let text = content.trim();
        if text.is_empty() {
            return Err(AppError::bad_request("配置不能是空的"));
        }
        serde_json::from_str::<serde_json::Value>(text)
            .map_err(|e| AppError::bad_request(format!("JSON 不合法，没敢写：{e}")))?;
        if !can_write(&path) {
            return Err(AppError::bad_request(format!(
                "改不了 {} —— 面板得用 root 跑才能动这个文件",
                path.display()
            )));
        }

        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }

        // 备份：文件名带时间戳，改错了能直接 cp 回去。
        let backup = if path.exists() {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let dest = path.with_extension(format!("json.bak-{stamp}"));
            std::fs::copy(&path, &dest).ok().map(|_| dest)
        } else {
            None
        };

        // 先写临时文件再 rename：dockerd 读到的永远是完整的一份。
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, format!("{text}\n"))
            .map_err(|e| AppError::internal(format!("写临时文件失败：{e}")))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| AppError::internal(format!("替换配置失败：{e}")))?;

        let restarted = Self::restart_engine();
        Ok(DaemonWriteResult {
            path: path.display().to_string(),
            backup: backup.map(|p| p.display().to_string()),
            restarted,
            message: if restarted {
                "配置已写入，Docker 正在重启".into()
            } else {
                "配置已写入，但没重启成 Docker —— 手动执行 systemctl restart docker"
                    .into()
            },
        })
    }

    /// 重启 Docker 引擎。这一步会连带重启**这台机器上所有容器**，所以界面那边
    /// 必须先跟用户确认过再调到这里。
    fn restart_engine() -> bool {
        let attempts: [&[&str]; 3] = [
            &["systemctl", "restart", "docker"],
            &["service", "docker", "restart"],
            &["systemctl", "restart", "docker.service"],
        ];
        attempts.iter().any(|args| {
            std::process::Command::new(args[0])
                .args(&args[1..])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        })
    }
}

/// 这个进程能不能写目标文件。
///
/// 不猜权限位：直接开一次 / 往目录里试建一个临时文件。权限位在 ACL、容器里挂的
/// 卷、只读挂载这些情况下都和实际能不能写对不上。
fn can_write(path: &std::path::Path) -> bool {
    if path.exists() {
        return std::fs::OpenOptions::new().append(true).open(path).is_ok();
    }
    let Some(dir) = path.parent() else {
        return false;
    };
    if !dir.exists() {
        // 目录本身还不存在（比如全新机器上 /etc/docker 没建）：只有 root 才敢说能。
        return is_root();
    }
    let probe = dir.join(".zops-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn is_root() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "0")
        .unwrap_or(false)
}
