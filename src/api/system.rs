use std::sync::Arc;

use axum::{extract::State, Json, Router};
use serde::Serialize;
use sysinfo::{Disks, Networks, System};

use crate::state::AppState;

#[derive(Serialize)]
pub struct SystemInfo {
    hostname: String,
    os: String,
    kernel: String,
    uptime_secs: u64,
    cpu_usage: f32,
    cpu_cores: usize,
    memory_total: u64,
    memory_used: u64,
    memory_percent: f32,
    swap_total: u64,
    swap_used: u64,
    disks: Vec<DiskInfo>,
    network: Vec<NetInfo>,
    load_avg: Vec<f64>,
    processes: usize,
}

#[derive(Serialize)]
pub struct DiskInfo {
    mount: String,
    total: u64,
    used: u64,
    percent: f32,
}

#[derive(Serialize)]
pub struct NetInfo {
    name: String,
    rx_bytes: u64,
    tx_bytes: u64,
}

async fn overview(State(state): State<Arc<AppState>>) -> Json<SystemInfo> {
    let mut sys = state.sysinfo.lock().unwrap();
    sys.refresh_all();

    let hostname = System::host_name().unwrap_or_default();
    let os = std::env::consts::OS.to_string();
    let kernel = System::kernel_version().unwrap_or_default();
    let uptime_secs = System::uptime();
    let load_avg = System::load_average();
    let processes = sys.processes().len();

    let cpu_usage = sys.global_cpu_usage();
    let cpu_cores = sys.cpus().len();

    let mem = sys.total_memory();
    let mused = sys.used_memory();
    let mem_percent = if mem > 0 {
        mused as f32 / mem as f32 * 100.0
    } else {
        0.0
    };
    let swap = sys.total_swap();
    let sused = sys.used_swap();

    let disks: Vec<DiskInfo> = Disks::new_with_refreshed_list()
        .iter()
        .map(|d| DiskInfo {
            mount: d.mount_point().display().to_string(),
            total: d.total_space(),
            used: d.total_space() - d.available_space(),
            percent: if d.total_space() > 0 {
                (d.total_space() - d.available_space()) as f32 / d.total_space() as f32 * 100.0
            } else {
                0.0
            },
        })
        .collect();

    let net: Vec<NetInfo> = Networks::new_with_refreshed_list()
        .iter()
        .map(|(name, data)| NetInfo {
            name: name.clone(),
            rx_bytes: data.total_received(),
            tx_bytes: data.total_transmitted(),
        })
        .collect();

    Json(SystemInfo {
        hostname,
        os,
        kernel,
        uptime_secs,
        cpu_usage,
        cpu_cores,
        memory_total: mem,
        memory_used: mused,
        memory_percent: mem_percent,
        swap_total: swap,
        swap_used: sused,
        disks,
        network: net,
        load_avg: vec![load_avg.one, load_avg.five, load_avg.fifteen],
        processes,
    })
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new().route("/overview", axum::routing::get(overview))
}
