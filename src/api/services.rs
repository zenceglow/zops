use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json, Router,
};
use bollard::container::{
    ListContainersOptions, LogsOptions, RemoveContainerOptions, StopContainerOptions,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::state::{check_docker_available, AppState};

type ApiError = (StatusCode, &'static str);
const ERR_DOCKER: ApiError = (StatusCode::BAD_GATEWAY, "Docker 不可用");
const ERR_INTERNAL: ApiError = (StatusCode::INTERNAL_SERVER_ERROR, "操作失败");

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

async fn docker_status(
) -> Json<DockerStatus> {
    let available = check_docker_available();
    let version = if available {
        std::process::Command::new("docker")
            .args(["version", "--format", "{{.Server.Version}}"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string()))
            .unwrap_or_default()
    } else {
        String::new()
    };

    Json(DockerStatus { available, version })
}

async fn list(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ContainerList>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;

    let options = ListContainersOptions::<String> {
        all: true,
        ..Default::default()
    };
    let containers = docker.list_containers(Some(options)).await.map_err(|_| ERR_INTERNAL)?;

    let list: Vec<ContainerDto> = containers
        .into_iter()
        .map(|c| ContainerDto {
            id: c.id.unwrap_or_default()[..12].to_string(),
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
        })
        .collect();

    Ok(Json(ContainerList { containers: list }))
}

async fn start(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;
    docker
        .start_container::<String>(&id, None)
        .await
        .map_err(|_| ERR_INTERNAL)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn stop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;
    docker
        .stop_container(&id, None::<StopContainerOptions>)
        .await
        .map_err(|_| ERR_INTERNAL)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn restart(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;
    docker
        .restart_container(&id, None)
        .await
        .map_err(|_| ERR_INTERNAL)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn remove(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;
    docker
        .remove_container(&id, None::<RemoveContainerOptions>)
        .await
        .map_err(|_| ERR_INTERNAL)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

#[derive(Deserialize)]
pub struct LogsQuery {
    tail: Option<usize>,
}

async fn logs(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<LogsQuery>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let docker = state.docker.as_ref().ok_or(ERR_DOCKER)?;
    let tail = q.tail.unwrap_or(100);

    let options = LogsOptions::<String> {
        stdout: true,
        stderr: true,
        tail: tail.to_string(),
        ..Default::default()
    };

    let mut stream = docker.logs(&id, Some(options));
    let mut lines: Vec<String> = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(output) => lines.push(output.to_string()),
            Err(_) => break,
        }
    }

    Ok(Json(serde_json::json!({"logs": lines})))
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", axum::routing::get(docker_status))
        .route("/", axum::routing::get(list))
        .route("/{id}/start", axum::routing::post(start))
        .route("/{id}/stop", axum::routing::post(stop))
        .route("/{id}/restart", axum::routing::post(restart))
        .route("/{id}/remove", axum::routing::delete(remove))
        .route("/{id}/logs", axum::routing::get(logs))
}
