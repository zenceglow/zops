//! 盯两件会让人半夜爬起来的事：机器压力越线、容器掉线。
//!
//! 通知渠道配好了没人发，等于没配。这个任务就是那个"没人发"里最有价值的两条：
//! 磁盘写满、容器挂了 —— 都是不该等到用户第二天打开面板才知道的事。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::domain::system::SystemOverview;
use crate::service::{
    container::ContainerService, notify::NotifyService, system::SystemService,
};

/// 压力越线阈值。和界面上"告急"那一档对齐（≥90%）。
const PRESSURE_AT: f32 = 90.0;
/// 同一条告警的冷却时间。压力是持续状态，不冷却会一分钟一条刷爆群。
const COOLDOWN: Duration = Duration::from_secs(30 * 60);
const POLL: Duration = Duration::from_secs(60);

pub struct Watcher {
    notify: Arc<NotifyService>,
    system: Arc<SystemService>,
    containers: Arc<ContainerService>,
}

impl Watcher {
    pub fn new(
        notify: Arc<NotifyService>,
        system: Arc<SystemService>,
        containers: Arc<ContainerService>,
    ) -> Self {
        Self {
            notify,
            system,
            containers,
        }
    }

    pub async fn run(self) {
        let mut last_alert: Option<Instant> = None;
        // None = 还没取到第一份快照。第一次不能报"全挂了"，那只是我们刚开始看。
        let mut running: Option<HashSet<String>> = None;

        loop {
            tokio::time::sleep(POLL).await;

            let overview = self.system.overview();
            let (worst, which) = worst_pressure(&overview);
            if worst >= PRESSURE_AT {
                let due = last_alert
                    .map(|t| t.elapsed() >= COOLDOWN)
                    .unwrap_or(true);
                if due {
                    let title = format!("{} 压力 {:.0}%", crate::service::notify::hostname(), worst);
                    let text = format!(
                        "瓶颈在{}：CPU {:.0}%，内存 {:.0}%，磁盘 {:.0}%，Swap {:.0}%，负载 {:.1}。",
                        which,
                        overview.cpu_usage,
                        overview.memory_percent,
                        worst_disk(&overview),
                        swap_percent(&overview),
                        overview.load_avg.first().copied().unwrap_or(0.0),
                    );
                    let (sent, ok) = self.notify.broadcast("pressure", &title, &text).await;
                    // 只有真发出去才开始冷却：渠道配错了就一声不吭，比重复提醒更糟。
                    if sent > 0 && ok > 0 {
                        last_alert = Some(Instant::now());
                    }
                }
            } else {
                // 回落了就把冷却清掉，下次越线立刻提醒，不用等满半小时。
                last_alert = None;
            }

            if let Ok(list) = self.containers.list().await {
                let now: HashSet<String> = list
                    .containers
                    .iter()
                    .filter(|c| c.state == "running")
                    .map(|c| c.name.clone())
                    .collect();
                if let Some(prev) = running.as_ref() {
                    let mut gone: Vec<&String> = prev.difference(&now).collect();
                    gone.sort();
                    for name in gone {
                        let title = format!("容器掉线：{name}");
                        let text = format!(
                            "{} 上的 {name} 不在运行了。先看它的日志再决定要不要重启。",
                            crate::service::notify::hostname()
                        );
                        self.notify.broadcast("container", &title, &text).await;
                    }
                }
                running = Some(now);
            }
        }
    }
}

fn swap_percent(o: &SystemOverview) -> f32 {
    if o.swap_total == 0 {
        0.0
    } else {
        (o.swap_used as f32 / o.swap_total as f32) * 100.0
    }
}

fn worst_disk(o: &SystemOverview) -> f32 {
    o.disks
        .iter()
        .filter(|d| d.total >= 1 << 30)
        .map(|d| d.percent)
        .fold(0.0, f32::max)
}

/// 压力和界面上一样取最紧张的那一项，并回传是哪一项。
fn worst_pressure(o: &SystemOverview) -> (f32, &'static str) {
    let load = if o.cpu_cores > 0 {
        (o.load_avg.first().copied().unwrap_or(0.0) as f32 / o.cpu_cores as f32) * 100.0
    } else {
        0.0
    };
    [
        (o.cpu_usage, "CPU"),
        (o.memory_percent, "内存"),
        (worst_disk(o), "磁盘"),
        (swap_percent(o), "Swap"),
        (load, "负载"),
    ]
    .into_iter()
    .fold((0.0, "CPU"), |acc, cur| if cur.0 > acc.0 { cur } else { acc })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::system::{DiskInfo, SystemOverview};

    fn overview() -> SystemOverview {
        SystemOverview {
            hostname: "h".into(),
            os: String::new(),
            kernel: String::new(),
            uptime_secs: 0,
            cpu_usage: 10.0,
            cpu_cores: 8,
            memory_total: 16 << 30,
            memory_used: 8 << 30,
            memory_percent: 50.0,
            swap_total: 4 << 30,
            swap_used: 1 << 30,
            disks: vec![DiskInfo {
                mount: "/".into(),
                total: 100 << 30,
                used: 40 << 30,
                percent: 40.0,
            }],
            network: vec![],
            load_avg: vec![4.0],
            processes: 1,
        }
    }

    #[test]
    fn 压力取最紧张的一项() {
        let mut o = overview();
        assert_eq!(worst_pressure(&o).1, "内存"); // 50% 最高
        o.cpu_usage = 97.0;
        assert_eq!(worst_pressure(&o), (97.0, "CPU"));
        // 负载按核数折算：4 核上 load=4 就是刚好跑满。
        o.cpu_usage = 10.0;
        o.cpu_cores = 4;
        o.load_avg = vec![4.0];
        assert_eq!(worst_pressure(&o), (100.0, "负载"));
    }

    #[test]
    fn 小分区不算进磁盘压力() {
        let mut o = overview();
        o.memory_percent = 1.0;
        o.disks = vec![DiskInfo {
            mount: "/var/lib/docker".into(),
            total: 100 << 20, // 100MB 的 overlay
            used: 99 << 20,
            percent: 99.0,
        }];
        assert_eq!(worst_pressure(&o).1, "负载"); // 8 核 load 4 = 50%
    }
}
