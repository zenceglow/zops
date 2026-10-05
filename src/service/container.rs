use std::sync::Arc;

use crate::domain::container::{ContainerList, DockerStatus};
use crate::domain::container::{DockerInfo, ImageList, NetworkList};
use crate::infrastructure::docker::DockerClient;
use crate::shared::AppError;

pub struct ContainerService {
    docker: Arc<DockerClient>,
}

impl ContainerService {
    pub fn new(docker: Arc<DockerClient>) -> Self {
        Self { docker }
    }

    pub fn status(&self) -> DockerStatus {
        DockerStatus {
            available: DockerClient::is_available(),
            version: DockerClient::version(),
        }
    }

    pub async fn list(&self) -> Result<ContainerList, AppError> {
        Ok(ContainerList {
            containers: self.docker.list_containers().await?,
        })
    }

    pub async fn images(&self) -> Result<ImageList, AppError> {
        self.docker.list_images().await
    }

    pub async fn networks(&self) -> Result<NetworkList, AppError> {
        self.docker.list_networks().await
    }

    pub async fn info(&self) -> DockerInfo {
        self.docker.info().await
    }

    pub async fn start(&self, id: &str) -> Result<(), AppError> {
        self.docker.start(id).await
    }

    pub async fn stop(&self, id: &str) -> Result<(), AppError> {
        self.docker.stop(id).await
    }

    pub async fn restart(&self, id: &str) -> Result<(), AppError> {
        self.docker.restart(id).await
    }

    pub async fn remove(&self, id: &str) -> Result<(), AppError> {
        self.docker.remove(id).await
    }

    pub async fn logs(&self, id: &str, tail: usize) -> Result<serde_json::Value, AppError> {
        let logs = self.docker.logs(id, tail).await?;
        Ok(serde_json::json!({ "logs": logs }))
    }

    /// 扫一遍可清理项（悬空镜像 / 已停止容器 / 未使用网络）。不碰卷。
    pub async fn junk_summary(
        &self,
    ) -> Result<crate::infrastructure::docker::JunkSummary, AppError> {
        self.docker.junk_summary().await
    }

    /// 清理垃圾（悬空镜像 / 已停止容器 / 未使用网络）。不碰卷。
    pub async fn prune(
        &self,
        what: &crate::infrastructure::docker::PruneRequest,
    ) -> Result<crate::infrastructure::docker::PruneResult, AppError> {
        self.docker.prune(what).await
    }
}
