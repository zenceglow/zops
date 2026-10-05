use serde::Serialize;

#[derive(Serialize)]
pub struct ContainerDto {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub ports: String,
    /// 启动时刻（RFC3339）。列表接口只给 "Up 3 days" 这种相对时间，这里由
    /// inspect 补齐；已停止且从未启动过的容器为空串。
    pub started_at: String,
}

#[derive(Serialize)]
pub struct ContainerList {
    pub containers: Vec<ContainerDto>,
}

#[derive(Serialize)]
pub struct DockerStatus {
    pub available: bool,
    pub version: String,
}
