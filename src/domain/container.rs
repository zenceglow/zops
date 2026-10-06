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
    /// 单核百分比（100% = 占满一个核）。已停止的容器取不到，为 None。
    pub cpu_percent: Option<f64>,
    /// 实际占用内存（已扣掉 page cache）与上限，单位字节。
    pub mem_used: Option<u64>,
    pub mem_limit: Option<u64>,
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

/// 一个镜像。字段跟着 `docker images` 那几列走，够用就行。
#[derive(Serialize)]
pub struct ImageDto {
    pub id: String,
    /// `repo:tag`，可能有多个；`<none>:<none>` 的悬空镜像 tags 为空。
    pub tags: Vec<String>,
    pub size: u64,
    /// 创建时刻（Unix 秒）。
    pub created: i64,
    /// 有几个容器在用。
    pub containers: i64,
    /// 没有 tag 的悬空镜像 —— 也就是"垃圾"那一类。
    pub dangling: bool,
}

#[derive(Serialize)]
pub struct ImageList {
    pub images: Vec<ImageDto>,
    /// 悬空镜像占的字节数，清理弹窗和概览都用它。
    pub dangling_size: u64,
}

#[derive(Serialize)]
pub struct NetworkDto {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    /// 接在这个网络上的容器数。
    pub containers: usize,
    /// 第一个子网，没有就空字符串。
    pub subnet: String,
}

#[derive(Serialize)]
pub struct NetworkList {
    pub networks: Vec<NetworkDto>,
}

/// Docker 引擎自身的配置。
///
/// 直接给 `docker info` 的原始 JSON：面板不该挑字段 —— 用户想看的恰恰是
/// "这个引擎到底怎么配的"，挑过的字段反而让人怀疑少了什么。
#[derive(Serialize)]
pub struct DockerInfo {
    pub available: bool,
    pub info: serde_json::Value,
    pub version: serde_json::Value,
}

/// 引擎配置文件（daemon.json）的当前样子。
///
/// 单独把 registry-mirrors / insecure-registries 拎出来，是因为这两个是**真正会
/// 被改**的字段 —— 国内拉不动 Docker Hub 时第一件事就是加镜像加速器，而"手写
/// JSON 再 scp 上去"是这块最烦的一步。其余字段照原文给，编辑时不会丢。
#[derive(Serialize)]
pub struct DaemonFile {
    pub path: String,
    pub exists: bool,
    /// 原文。文件不在就是空串。
    pub content: String,
    /// 当前进程能不能写它（不是 root 就写不了）。
    pub can_write: bool,
    pub mirrors: Vec<String>,
    pub insecure_registries: Vec<String>,
}

/// 写完的结果。备份路径一定回给用户 —— 改错了得能退回去。
#[derive(Serialize)]
pub struct DaemonWriteResult {
    pub path: String,
    pub backup: Option<String>,
    pub restarted: bool,
    pub message: String,
}
