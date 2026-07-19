use std::collections::HashSet;
use std::sync::Mutex;

use sysinfo::{Disks, Networks, System};

use crate::domain::system::{DiskInfo, NetInfo, SystemOverview};

/// Drop virtual / Apple APFS helper mounts that mirror another volume's capacity.
fn should_skip_mount(mount: &str) -> bool {
    let m = mount.trim_end_matches('/');
    if m.is_empty() {
        return false;
    }
    // macOS APFS: Data/Preboot/VM share the container's free space with `/`
    if m.starts_with("/System/Volumes/") {
        return true;
    }
    if m.starts_with("/private/var/vm") || m == "/dev" || m.starts_with("/dev/") {
        return true;
    }
    false
}

/// Same total+used ⇒ same underlying capacity; keep the shorter mount (`/` over duplicates).
fn dedupe_disks(mut disks: Vec<DiskInfo>) -> Vec<DiskInfo> {
    disks.retain(|d| !should_skip_mount(&d.mount));
    disks.sort_by(|a, b| {
        a.mount
            .len()
            .cmp(&b.mount.len())
            .then_with(|| a.mount.cmp(&b.mount))
    });
    let mut seen = HashSet::new();
    disks.retain(|d| seen.insert((d.total, d.used)));
    disks
}

pub struct SysInfoProvider {
    sys: Mutex<System>,
}

impl SysInfoProvider {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new_all()),
        }
    }

    pub fn overview(&self) -> SystemOverview {
        let mut sys = self.sys.lock().unwrap();
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

        let disks = dedupe_disks(
            Disks::new_with_refreshed_list()
                .iter()
                .map(|d| DiskInfo {
                    mount: d.mount_point().display().to_string(),
                    total: d.total_space(),
                    used: d.total_space() - d.available_space(),
                    percent: if d.total_space() > 0 {
                        (d.total_space() - d.available_space()) as f32 / d.total_space() as f32
                            * 100.0
                    } else {
                        0.0
                    },
                })
                .collect(),
        );

        let network: Vec<NetInfo> = Networks::new_with_refreshed_list()
            .iter()
            .map(|(name, data)| NetInfo {
                name: name.clone(),
                rx_bytes: data.total_received(),
                tx_bytes: data.total_transmitted(),
            })
            .collect();

        SystemOverview {
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
            network,
            load_avg: vec![load_avg.one, load_avg.five, load_avg.fifteen],
            processes,
        }
    }
}
