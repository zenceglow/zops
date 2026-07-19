use serde::Serialize;

#[derive(Serialize)]
pub struct ContainerDto {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub ports: String,
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
