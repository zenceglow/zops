//! 宿主机的网段与端口保留范围。
//!
//! 一键部署前要回答两个靠读 compose 回答不了的问题：
//!
//! 1. **这张 docker 网络的子网，会不会和宿主已有的网络撞上。** 撞上时容器能起来、
//!    端口也通，但容器去访问落在重叠段里的内网机器会被路由到自己那张网桥上，
//!    表现是"装好了但连不上那台服务" —— 报错都没有，最难查的一类。
//! 2. **用户挑的宿主端口，是不是落在内核的临时端口范围里。** 这个范围内现在可能
//!    空着，但内核会拿它做随机出站端口。今天装好、过几天其中一个连接把它占了，
//!    就变成"这个库昨天还好好的，今天连不上"。
//!
//! 两个探测都遵循 `ports.rs` 立的同一条规矩：**读不到就返回空，调用方要当成
//! "不知道"，不能当成"没问题"**。
//!
//! 只做 Linux。生产是 Alinux，本机是 macOS —— macOS 上没有 `ip` 也没有
//! `/proc`，两个函数自然返回空，调用方跳过检查，不会误报。

use std::process::Command;

use serde::Serialize;

/// 一个 IPv4 网段，已经算成闭区间的整数范围。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Cidr {
    /// 原样保留的写法（`172.16.0.0/12`），用来给用户看。
    pub raw: String,
    pub start: u32,
    pub end: u32,
}

impl Cidr {
    /// `172.16.0.0/12` → 范围。掩码外的位一律抹掉，所以 `172.16.5.7/12` 和
    /// `172.16.0.0/12` 解析出同一个范围 —— 用户写的地址带主机位时不该影响判断。
    pub fn parse(s: &str) -> Option<Cidr> {
        let (addr, len) = s.trim().split_once('/')?;
        let len: u32 = len.trim().parse().ok()?;
        if len > 32 {
            return None;
        }
        let ip: std::net::Ipv4Addr = addr.trim().parse().ok()?;
        // len 为 0 时 `32 - len` 是 32，u32 左移 32 位在 debug 下直接 panic，
        // 所以 0 单独拿出来。
        let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
        let start = u32::from(ip) & mask;
        let end = start | !mask;
        Some(Cidr {
            raw: s.trim().to_string(),
            start,
            end,
        })
    }

    /// 两段有交集。用区间比较而不是逐位算掩码：带主机位、掩码长度不一致的写法
    /// （`172.17.0.0/16` 对 `172.16.0.0/12`）这样才不会漏判。
    pub fn overlaps(&self, other: &Cidr) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

/// 宿主上已经配置的网段（不含默认路由，不含 docker 自己建的网桥）。
///
/// 非 Linux 或 `ip` 不存在时返回空 = 不知道。
pub fn host_cidrs() -> Vec<Cidr> {
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    match run("ip", &["-o", "-4", "route", "show"]) {
        Some(text) => parse_routes(&text),
        None => Vec::new(),
    }
}

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `172.16.0.0/12 dev eth0 proto kernel scope link src 172.16.1.5`
/// `default via 172.16.0.1 dev eth0 proto dhcp metric 100`
fn parse_routes(text: &str) -> Vec<Cidr> {
    let mut out: Vec<Cidr> = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let Some(first) = cols.first() else { continue };
        // 默认路由是 0.0.0.0/0，跟**任何**网段都重叠。留着它，每条检查都报冲突。
        if *first == "default" {
            continue;
        }
        let Some(cidr) = Cidr::parse(first) else {
            continue;
        };
        let dev = cols
            .iter()
            .position(|c| *c == "dev")
            .and_then(|i| cols.get(i + 1))
            .copied()
            .unwrap_or("");
        // **docker 自己建的网桥也在路由表里。** 不排掉的话，检查任何一张 docker
        // 网络都会"撞上自己"，所有网络一律报重叠 —— 一个恒真的检查比没有检查更糟。
        if is_container_iface(dev) {
            continue;
        }
        // 同一接口上可能既有 /12 又有它的 /24，去重免得报两遍。
        if !out.iter().any(|c| c.start == cidr.start && c.end == cidr.end) {
            out.push(cidr);
        }
    }
    out
}

/// 按名字认容器网桥。`br-` 是用户自定义网络、`veth` 是容器那头的配对端、
/// `cni` 是 k8s 插的。
fn is_container_iface(dev: &str) -> bool {
    dev == "docker0"
        || dev.starts_with("br-")
        || dev.starts_with("veth")
        || dev.starts_with("virbr")
        || dev.starts_with("cni")
}

/// 内核给随机出站连接用的端口范围，读 `/proc/sys/net/ipv4/ip_local_port_range`。
///
/// 读不到（非 Linux、容器里没挂 /proc）返回 None。
pub fn ephemeral_port_range() -> Option<(u16, u16)> {
    let text = std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range").ok()?;
    let mut it = text.split_whitespace();
    let lo: u16 = it.next()?.parse().ok()?;
    let hi: u16 = it.next()?.parse().ok()?;
    (lo <= hi).then_some((lo, hi))
}

/// `docker compose version`。
///
/// 单独探测它的理由：安装脚本写的是 `docker compose`（v2 子命令），机器上只有 v1 的
/// `docker-compose` 时脚本第一行就失败，日志里只有一句 command not found，看不出
/// 是缺插件。
///
/// 这个探测**不需要 daemon** —— docker 没跑的时候它照样成功。所以它不会和
/// "docker 连不上"混成一句话。
///
/// 返回 `None` 表示连 `docker` 命令本身都执行不了（那是另一个问题，不该在这里
/// 冒充成"没有 compose 插件"）。
pub fn compose_plugin_available() -> Option<bool> {
    let out = Command::new("docker")
        .args(["compose", "version"])
        .output()
        .ok()?;
    Some(out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得路由表里的一行() {
        let text = "\
default via 172.16.0.1 dev eth0 proto dhcp metric 100
172.16.0.0/12 dev eth0 proto kernel scope link src 172.16.1.5
10.0.0.0/8 via 172.16.1.1 dev eth0";
        let rows = parse_routes(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].raw, "172.16.0.0/12");
        assert_eq!(rows[1].raw, "10.0.0.0/8");
    }

    #[test]
    fn 默认路由不算冲突() {
        // 0.0.0.0/0 与任何网段都重叠。要是把它算进去，每条检查都会报"冲突"，
        // 用户就学会无视这个提示了。
        let rows = parse_routes("default via 172.16.0.1 dev eth0");
        assert!(rows.is_empty());
    }

    #[test]
    fn docker_自己的网桥不算冲突() {
        // 这条是重点：docker0 / br-xxx 就在路由表里。不排掉的话，检查任何一张
        // docker 网络都会"撞上自己"。
        let text = "\
172.17.0.0/16 dev docker0 proto kernel scope link src 172.17.0.1
172.18.0.0/16 dev br-1a2b3c proto kernel scope link src 172.18.0.1
172.19.0.0/16 dev eth0 proto kernel scope link src 172.19.0.5";
        let rows = parse_routes(text);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].raw, "172.19.0.0/16");
    }

    #[test]
    fn 重复网段只报一次() {
        let text = "\
10.0.0.0/8 dev eth0 proto kernel scope link src 10.1.1.1
10.1.2.0/24 dev eth0 proto kernel scope link src 10.1.2.1";
        // /8 覆盖 /24，区间相同吗？不同 —— 所以两条都留。真正重复的是完全一样的段。
        let rows = parse_routes(text);
        assert_eq!(rows.len(), 2);
        let dup = "\
10.0.0.0/8 dev eth0
10.0.0.0/8 dev eth1";
        assert_eq!(parse_routes(dup).len(), 1);
    }

    #[test]
    fn 段里的主机位不影响判断() {
        let a = Cidr::parse("172.16.5.7/12").unwrap();
        let b = Cidr::parse("172.16.0.0/12").unwrap();
        assert_eq!(a.start, b.start);
        assert_eq!(a.end, b.end);
    }

    #[test]
    fn 短掩码盖住长掩码才算重叠() {
        let docker = Cidr::parse("172.17.0.0/16").unwrap();
        // 经典情况：内网是 172.16.0.0/12，docker 默认网段正好落在里面。
        assert!(docker.overlaps(&Cidr::parse("172.16.0.0/12").unwrap()));
        assert!(!docker.overlaps(&Cidr::parse("10.0.0.0/8").unwrap()));
        assert!(!docker.overlaps(&Cidr::parse("172.18.0.0/16").unwrap()));
        // 相邻不算撞。
        assert!(!Cidr::parse("172.17.0.0/16")
            .unwrap()
            .overlaps(&Cidr::parse("172.18.0.0/16").unwrap()));
    }

    #[test]
    fn 零掩码与全掩码都不会算崩() {
        let all = Cidr::parse("0.0.0.0/0").unwrap();
        assert_eq!((all.start, all.end), (0, u32::MAX));
        let one = Cidr::parse("192.168.1.7/32").unwrap();
        assert_eq!(one.start, one.end);
        assert!(all.overlaps(&one));
    }

    #[test]
    fn 认不出的写法直接丢掉() {
        assert!(Cidr::parse("172.16.0.0").is_none());
        assert!(Cidr::parse("172.16.0.0/33").is_none());
        assert!(Cidr::parse("not-an-ip/24").is_none());
        assert!(Cidr::parse("").is_none());
    }

    #[test]
    fn 临时端口范围读得到就成对() {
        // 本机（macOS）读不到 /proc，返回 None 也算通过：调用方要跳过检查。
        if let Some((lo, hi)) = ephemeral_port_range() {
            assert!(lo < hi);
            assert!(hi > 1024);
        }
    }
}
