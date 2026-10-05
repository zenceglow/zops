use bollard::container::{
    InspectContainerOptions, ListContainersOptions, LogsOptions, RemoveContainerOptions,
    StopContainerOptions,
};
use bollard::{Docker, API_DEFAULT_VERSION};
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

pub struct DockerClient {
    docker: Option<Docker>,
}

impl DockerClient {
    pub fn connect() -> Self {
        Self {
            docker: Self::build_client(),
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

        let mut out = Vec::with_capacity(containers.len());
        for c in containers {
            let raw_id = c.id.unwrap_or_default();
            // 列表接口只给相对时间（"Up 3 days"），要显示"具体几点启动"必须逐个
            // inspect。容器通常是个位数，这点额外往返比专门加一个聚合接口划算。
            // 取不到就当未知，不影响列表本身。
            let started_at = docker
                .inspect_container(&raw_id, None::<InspectContainerOptions>)
                .await
                .ok()
                .and_then(|i| i.state.and_then(|s| s.started_at))
                .unwrap_or_default();

            out.push(ContainerDto {
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
                state: c.state.unwrap_or_default(),
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
            });
        }

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
