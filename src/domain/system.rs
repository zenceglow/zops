use serde::Serialize;

#[derive(Serialize)]
pub struct SystemOverview {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub cpu_usage: f32,
    pub cpu_cores: usize,
    pub memory_total: u64,
    pub memory_used: u64,
    pub memory_percent: f32,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<DiskInfo>,
    pub network: Vec<NetInfo>,
    pub load_avg: Vec<f64>,
    pub processes: usize,
}

#[derive(Serialize)]
pub struct DiskInfo {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub percent: f32,
}

#[derive(Serialize)]
pub struct NetInfo {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}
