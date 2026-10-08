//! 应用市场。
//!
//! 三层，各管各的：
//! - **清单**（`domain::app_catalog`）说"这个应用要什么"；
//! - **这里**把清单 + 用户填的参数渲染成 compose 与脚本，并做参数校验；
//! - **部署任务通道**（`service::deploy_job`）负责落盘、跑、留记录、给日志。
//!
//! 之所以不自己写一套执行器：这台机器上已经有二十来个服务在靠部署任务通道跑，
//! 记录、日志、并发锁都在那儿。应用市场是"预置好的部署任务"，不是第二条通道。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::domain::app_catalog::{self, AppSpec};
use crate::domain::container::NetworkDto;
use crate::domain::deploy_job::{DeployJob, DeployRun};
use crate::infrastructure::system::net::{self, Cidr};
use crate::infrastructure::system::ports::{listeners, PortUsage};
use crate::infrastructure::system::suggest_free;
use crate::service::container::ContainerService;
use crate::service::deploy_job::{valid_name, DeployJobService};
use crate::shared::AppError;

/// 网关后面那层 docker 内网的既有名字。清单的默认值、以及这台机器上其它 compose
/// 用的都是它。
pub const DEFAULT_NETWORK: &str = "local";

/// 容器时区。和这台机器上其它 compose 一致。
const TZ: &str = "Asia/Shanghai";

/// 认领"这个应用装在哪"的标记文件，落在部署目录里。
///
/// 不留标记就得靠"名字 == 应用默认名"来认，用户一改名就认不出来了（卡片会显示
/// 未安装，再点一次就变成装第二份）。标记里**不写密码**：值在 compose 里，
/// 这里只记"当时填了哪些键"，够一个重装界面回填默认值就行。
const MARKER_FILE: &str = ".zops-app.json";

/// 目录里的部署目录名上限，和服务层保持一致。
const MAX_NAME: usize = 41;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppMarker {
    app: String,
    #[serde(default)]
    network: String,
    #[serde(default)]
    ports: HashMap<String, u16>,
}

// ── 请求 / 响应 ──

#[derive(Debug, Clone, Default, Deserialize)]
pub struct InstallOptions {
    /// 目录里的应用 id。
    ///
    /// 字段一律用**单词**命名（`app` / `name` / `ports` / `env`），所以 HTTP 体、
    /// MCP 参数、Rust 字段三处是同一个词，不存在 camelCase / snake_case 的换算。
    /// 这里本来也没有多词字段需要换算。
    pub app: String,
    /// 应用名，同时是部署目录名与容器名。留空用清单默认名。
    #[serde(default)]
    pub name: String,
    /// docker 网络。留空用 `local`。
    #[serde(default)]
    pub network: String,
    /// 端口 key → 宿主端口。缺的用清单默认值。
    #[serde(default)]
    pub ports: HashMap<String, u16>,
    /// 环境变量。缺的用清单默认值。
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    pub job_id: String,
    pub name: String,
    pub dir: String,
    /// draft | running | success | failed
    pub status: String,
    pub network: String,
    pub ports: HashMap<String, u16>,
    pub container_id: Option<String>,
    pub last_run_at: Option<String>,
    pub last_exit_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MarketApp {
    #[serde(flatten)]
    pub spec: AppSpec,
    /// 装过就有，没装过是 null。
    pub installed: Option<InstalledApp>,
}

impl MarketApp {
    /// 目录 id。`spec` 是 flatten 进 JSON 的，所以 Rust 这边访问要过一层 ——
    /// 前端看到的是扁平的 `{ id, name, …, installed }`。
    pub fn app_id(&self) -> &str {
        self.spec.id
    }
}

/// 预检结论的严重程度。
///
/// 分两级不是排版讲究，是**要不要让人点下去**的分界：
/// - `Block`：现在点下去一定失败。前端据此禁用按钮，后端也会在 `install` 里拒绝。
/// - `Warn`：装得上，但会和别的东西撞、或者过几天才出问题。只提示。
///
/// 早先这些都平铺在一个 `warnings: Vec<String>` 里，结果是"端口已经被占用"
/// 和"这个应用没有探活"看起来一样重 —— 用户点下去才看到 docker 报错。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckLevel {
    Block,
    Warn,
}

impl CheckLevel {
    pub fn is_block(self) -> bool {
        matches!(self, CheckLevel::Block)
    }
}

/// 一条预检结论。
///
/// `detail` 说清"具体是谁跟谁撞"，`fix` 说清"改什么才能过去" —— 只说"端口被占"
/// 等于把排查丢给用户，他得自己去 `ss -lntp` 才知道是谁占的。
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub level: CheckLevel,
    /// 一句话说清是什么问题。
    pub title: String,
    /// 具体情况：谁占的、哪两段网段撞了。
    pub detail: String,
    /// 怎么改才能过去。
    pub fix: String,
}

impl Check {
    fn block(title: String, detail: String, fix: String) -> Self {
        Check {
            level: CheckLevel::Block,
            title,
            detail,
            fix,
        }
    }

    fn warn(title: String, detail: String, fix: String) -> Self {
        Check {
            level: CheckLevel::Warn,
            title,
            detail,
            fix,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallPlan {
    pub app: String,
    pub name: String,
    pub network: String,
    pub image: String,
    /// 渲染好的 compose。**密码已遮成 `******`** —— 预览是要给人看、会被复制的，
    /// 不该把明文密钥带到屏幕上。
    pub compose: String,
    pub script: String,
    /// 数据卷会在宿主机上建的目录（相对部署目录）。
    pub volumes: Vec<String>,
    /// 部署前检查：端口、内网、重名。
    pub checks: Vec<Check>,
    /// `checks` 里有阻塞项。前端据此禁用「一键部署」，省得自己再过滤一遍。
    pub blocked: bool,
    pub dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub job: DeployJob,
    pub run: DeployRun,
}

/// 校验并补齐默认值之后的参数。渲染只需要它，不再碰原始请求。
#[derive(Debug)]
struct Resolved {
    name: String,
    network: String,
    /// (key, 宿主端口, 容器端口)，顺序与清单一致。
    ports: Vec<(String, u16, u16)>,
    /// (key, 值, 是否机密)，顺序与清单一致。
    env: Vec<(String, String, bool)>,
}

pub struct AppMarketService {
    jobs: Arc<DeployJobService>,
    containers: Arc<ContainerService>,
}

impl AppMarketService {
    pub fn new(jobs: Arc<DeployJobService>, containers: Arc<ContainerService>) -> Self {
        Self { jobs, containers }
    }

    /// 目录 + 每个应用的安装态。
    pub fn list(&self) -> Result<Vec<MarketApp>, AppError> {
        let installed = self.installed_map()?;
        Ok(app_catalog::builtin()
            .into_iter()
            .map(|spec| {
                let hit = installed.get(spec.id).cloned();
                MarketApp {
                    spec,
                    installed: hit,
                }
            })
            .collect())
    }

    /// 扫一遍部署任务，把带标记文件的认出来。
    fn installed_map(&self) -> Result<HashMap<String, InstalledApp>, AppError> {
        let mut out: HashMap<String, InstalledApp> = HashMap::new();
        for job in self.jobs.list()? {
            let Some(marker) = read_marker(&job.dir) else {
                continue;
            };
            out.entry(marker.app.clone()).or_insert_with(|| InstalledApp {
                job_id: job.id.clone(),
                name: job.name.clone(),
                dir: job.dir.clone(),
                status: job.status.clone(),
                network: marker.network.clone(),
                ports: marker.ports.clone(),
                container_id: job.container_id.clone(),
                last_run_at: job.last_run_at.clone(),
                last_exit_code: job.last_exit_code,
            });
        }
        Ok(out)
    }

    /// 生成方案，不动任何东西。用户可以先把 compose 看一遍再决定装不装。
    ///
    /// 参数变化会被前端防抖地反复调用，所以这里只做**只读**探测：读监听表、读路由表、
    /// 问一次 docker。没有副作用，调多少次都一样。
    pub async fn plan(&self, opts: &InstallOptions) -> Result<InstallPlan, AppError> {
        let spec = lookup(&opts.app)?;
        let r = resolve(&spec, opts)?;
        let checks = self.preflight(&spec, &r).await;
        let blocked = checks.iter().any(|c| c.level.is_block());
        Ok(InstallPlan {
            app: spec.id.to_string(),
            name: r.name.clone(),
            network: r.network.clone(),
            image: spec.image.to_string(),
            compose: render_compose(&spec, &r, true),
            script: render_script(&spec),
            volumes: spec.volumes.iter().map(|v| v.host.to_string()).collect(),
            checks,
            blocked,
            dir: self.jobs.dir_of(&r.name).display().to_string(),
        })
    }

    /// 一键部署：预检 → 落 compose 与脚本 → 建部署任务 → 起容器。
    ///
    /// 起容器是**异步**的（`run()` 立刻返回一条 run 记录，真正跑在 spawn 出去的任务
    /// 里），前端拿 run.id 去 `/deploy/run/log` 拉实时日志。接口不快返回不行 ——
    /// 拉镜像可能要几分钟，HTTP 挂在那儿等就是超时。
    pub async fn install(
        &self,
        opts: &InstallOptions,
        actor: &str,
        actor_kind: &str,
    ) -> Result<InstallResult, AppError> {
        let spec = lookup(&opts.app)?;
        let r = resolve(&spec, opts)?;

        // 预检里有阻塞项就**停在这儿**。前端会把按钮禁掉，但这个判断不能只放在前端：
        // MCP 的 `ops_app_install` 是直接调这里的，绕过界面的调用同样不该被放行去
        // 拉几百 MB 镜像、再在最后一步失败。
        //
        // 注意窗口期：预检结论是"此刻"的。从 plan 到 install 之间端口可能被别的
        // 东西占走，那时 docker 会自己报错 —— 预检是提前预警，不是替代 docker 的检查。
        let checks = self.preflight(&spec, &r).await;
        let blockers: Vec<&Check> = checks.iter().filter(|c| c.level.is_block()).collect();
        if !blockers.is_empty() {
            let why = blockers
                .iter()
                .map(|c| format!("{}（{}）", c.title, c.fix))
                .collect::<Vec<_>>()
                .join("；");
            return Err(AppError::bad_request(format!("部署前检查没通过：{why}")));
        }

        let (_, _, job) = self.prepare_resolved(spec, r, actor, actor_kind)?;
        let run = self.jobs.run(&job.id, actor, actor_kind).await?;
        Ok(InstallResult {
            // 重读一次：run() 会改任务状态，返回创建前那份会让前端以为还没开始。
            job: self.jobs.get(&job.id)?,
            run,
        })
    }

    /// 只落地、不执行：校验 → 建数据目录 → 写 compose / 脚本 / 安装标记 → 建部署任务。
    ///
    /// 与 `install` 拆开有一个很具体的原因：`install` 的后半截会真的去
    /// `docker compose pull` 拉几百 MB 镜像。测试要验证的是"落盘的东西对不对"，
    /// 那就不能顺带把镜像拉下来 —— 所以把可验证的那半截单独切出来。
    fn prepare(
        &self,
        opts: &InstallOptions,
        actor: &str,
        actor_kind: &str,
    ) -> Result<(AppSpec, Resolved, DeployJob), AppError> {
        let spec = lookup(&opts.app)?;
        let r = resolve(&spec, opts)?;
        self.prepare_resolved(spec, r, actor, actor_kind)
    }

    /// `prepare` 的后半截：参数已经校验、默认值已经补齐，这里只负责落盘。
    ///
    /// 单独留一层是为了让 `install` 不用把 `resolve` 跑两遍（预检要用它、建目录也要用它）。
    fn prepare_resolved(
        &self,
        spec: AppSpec,
        r: Resolved,
        actor: &str,
        actor_kind: &str,
    ) -> Result<(AppSpec, Resolved, DeployJob), AppError> {
        // 数据目录先建出来：compose 的 bind mount 会自己建，但那是 root 建的、
        // 而且日志里看不出"这一步其实在动文件系统"。先建，失败了就是一句清楚的话。
        let dir = self.jobs.dir_of(&r.name);
        for v in &spec.volumes {
            let rel = safe_volume_dir(v.host)?;
            std::fs::create_dir_all(dir.join(&rel)).map_err(|e| {
                AppError::internal(format!("创建数据目录 {} 失败：{e}", dir.join(&rel).display()))
            })?;
        }

        let mut ports = HashMap::new();
        for (key, host, _) in &r.ports {
            ports.insert(key.clone(), *host);
        }
        let marker = AppMarker {
            app: spec.id.to_string(),
            network: r.network.clone(),
            ports,
        };
        let marker_body = serde_json::to_string_pretty(&marker)
            .map_err(|e| AppError::internal(format!("写安装标记失败：{e}")))?;

        let script = render_script(&spec);
        let files: Vec<(&str, String)> = vec![
            ("docker-compose.yml", render_compose(&spec, &r, false)),
            ("deploy.sh", script.clone()),
            (MARKER_FILE, marker_body),
        ];
        let note = format!("应用市场安装：{} {}", spec.name, spec.version);
        let job = self.jobs.create_rendered(
            &r.name,
            &note,
            "manual",
            actor,
            actor_kind,
            &files,
            &script,
        )?;
        Ok((spec, r, job))
    }

    /// 部署前检查。
    ///
    /// 分三块：端口、内网、其它（重名 / 没有探活 / 缺 compose 插件）。
    /// 判定逻辑全在下面的**纯函数**里，这里只负责取数 —— 真机上的监听表和路由表
    /// 在测试里造不出来，但判定分支必须每个都覆盖到。
    async fn preflight(&self, spec: &AppSpec, r: &Resolved) -> Vec<Check> {
        let mut out = port_findings(
            spec,
            r,
            &listeners(),
            &self.declared_ports(),
            net::ephemeral_port_range(),
        );

        // Docker 连不上时 `networks()` 报错，那是另一回事（概览页会报）。**不能**
        // 把 Err 和"没有这张网络"合并 —— Docker 一挂，所有部署都会显示"网络不存在"，
        // 用户会去建一堆网络然后发现问题根本不在那儿。
        match self.containers.networks().await {
            Ok(list) => {
                let found = list.networks.into_iter().find(|n| n.name == r.network);
                out.extend(network_findings(r, found.as_ref(), &net::host_cidrs()));
            }
            Err(_) => {}
        }

        if self.jobs.get_by_ref(&r.name).is_ok() {
            out.push(Check::block(
                format!("已经有一个叫 {} 的部署任务了", r.name),
                "部署任务名同时是目录名，重名时建任务会被直接拒掉".to_string(),
                format!("换个应用名，或先到「应用与服务」里把 {} 删掉", r.name),
            ));
        }

        if net::compose_plugin_available() == Some(false) {
            out.push(Check::block(
                "这台机器上没有 docker compose v2 插件".to_string(),
                "安装脚本用的是 `docker compose`（v2 子命令）。只有 v1 的 `docker-compose` 时，脚本第一行就失败，而日志里只有一句 command not found，看不出是缺插件".to_string(),
                "装一下 compose 插件（RHEL / Alinux 系：`yum install docker-compose-plugin`）".to_string(),
            ));
        }

        if spec.healthcheck.is_none() {
            out.push(Check::warn(
                format!("{} 不会有健康状态", spec.name),
                "官方镜像没有可靠的探活命令，容器列表里它永远显示「运行中」，看不出服务到底通没通".to_string(),
                "可以接受；要确认服务真的起来了，用卡片上的连接信息手动连一次".to_string(),
            ));
        }

        out
    }

    /// 这台机器上**其它**应用市场应用声明过的宿主端口。
    ///
    /// 不看容器在不在跑，只看安装标记。理由：一个停着的 mysql-1 声明了 3306，
    /// 现在装 mysql-2 也用 3306 会成功（端口确实是空的），但哪天把 mysql-1 起回来
    /// 就撞了 —— 这类"过几天才炸"的冲突正是要在装之前说出来的。
    fn declared_ports(&self) -> HashMap<u16, String> {
        let mut out = HashMap::new();
        let Ok(jobs) = self.jobs.list() else {
            return out;
        };
        for job in jobs {
            let Some(marker) = read_marker(&job.dir) else {
                continue;
            };
            for port in marker.ports.values() {
                out.entry(*port).or_insert_with(|| job.name.clone());
            }
        }
        out
    }
}

/// 端口检测。
///
/// 三种情况，严重程度不一样：
/// 1. **已经被监听** → 阻塞。docker 绑不上，`up -d` 一定失败。
/// 2. **落在内核临时端口范围** → 冲突。现在空着，但内核会拿这个范围做出站端口。
/// 3. **另一个应用市场应用声明过同一个端口** → 冲突。现在没事，等它起回来才撞。
fn port_findings(
    spec: &AppSpec,
    r: &Resolved,
    listening: &[PortUsage],
    declared: &HashMap<u16, String>,
    ephemeral: Option<(u16, u16)>,
) -> Vec<Check> {
    let mut out = Vec::new();

    // 同一个端口可能同时被 IPv4 和 IPv6 监听，`ss` 会给两行；先按端口归并，
    // 免得同一处冲突报两遍。
    let mut taken: HashMap<u16, &PortUsage> = HashMap::new();
    for l in listening {
        taken.entry(l.port).or_insert(l);
    }
    let busy: HashSet<u16> = taken.keys().copied().collect();

    for (key, host, container) in &r.ports {
        let label = port_label(spec, key);

        if let Some(l) = taken.get(host) {
            if l.container.as_deref() == Some(r.name.as_str()) {
                // 占着端口的就是这次要装的这个容器 —— 那多半是用户点了"重装"。
                // 该做的是先停掉旧容器，而不是换个端口（换端口等于留两份数据）。
                out.push(Check::block(
                    format!("{label} {host} 还被上一次装的 {} 占着", r.name),
                    format!(
                        "{} 正在 {}:{host} 上监听，它就是你这次要装的这一份",
                        r.name,
                        display_addr(l)
                    ),
                    format!("先到「应用与服务」里停掉（或删掉）{}，再回来部署", r.name),
                ));
            } else {
                out.push(Check::block(
                    format!("{label} {host} 已经被占用"),
                    format!(
                        "{} 正在 {}:{host} 上监听，docker 绑不上这个端口",
                        who_is(l),
                        display_addr(l)
                    ),
                    format!("把宿主端口换成别的（容器里照旧是 {container}），或先停掉 {}", who_is(l)),
                ));
            }
            // 已经占了就不用再报"将来会撞"这类次要的。
            continue;
        }

        if let Some((lo, hi)) = ephemeral {
            if (lo..=hi).contains(host) {
                let hint = match suggest_ordinary_port(&busy, lo) {
                    Some(p) => format!("换成 {p} 这类固定端口"),
                    None => format!("换一个 {lo} 以下的固定端口"),
                };
                out.push(Check::warn(
                    format!("{label} {host} 落在内核的临时端口范围里"),
                    format!(
                        "内核在 {lo}-{hi} 之间随机分配出站连接用的端口。现在它是空的，但这个范围内随时可能被一个普通请求占走 —— 表现是「装好几天之后突然连不上」"
                    ),
                    format!("{hint}（容器里照旧是 {container}）"),
                ));
            }
        }

        if let Some(other) = declared.get(host) {
            if other != &r.name {
                out.push(Check::warn(
                    format!("{label} {host} 和已安装的 {other} 声明的是同一个端口"),
                    format!("{other} 现在没起容器（否则上面就报「已被占用」了），但它装的时候声明的也是 {host}"),
                    format!("两个只能同时起一个：给这次换个宿主端口，或先删掉 {other}"),
                ));
            }
        }
    }

    out
}

/// 内网检测。
///
/// `net` 为 `None` 表示 docker 里没有这张网络。**调用方在 docker 连不上时不要
/// 调这个函数** —— 那种情况下"不知道"会被渲染成"不存在"，是假警报。
fn network_findings(r: &Resolved, net: Option<&NetworkDto>, host: &[Cidr]) -> Vec<Check> {
    let mut out = Vec::new();

    let Some(net) = net else {
        // compose 里写的是 external: true —— 意思是"去用已经存在的那张网"，
        // 不是"给我建一张"。不存在时 docker 直接拒绝启动：
        // network xxx declared as external, but could not be found
        out.push(Check::block(
            format!("docker 网络 {} 不存在", r.network),
            "compose 里这个网络是 external: true —— 意思是「去用它」，不是「建它」。不存在时 docker 会直接拒绝启动".to_string(),
            "在「Docker → 网络」里新建一个同名网络，或把这里改成已有的那张".to_string(),
        ));
        return out;
    };

    if net.internal {
        out.push(Check::block(
            format!("网络 {} 是禁止出网的（internal）", r.network),
            "internal 网络里的容器没有默认路由，`docker compose pull` 拉不到镜像，装到拉取那一步才失败".to_string(),
            "换一张非 internal 的网络；或者先把镜像拉到本机再装".to_string(),
        ));
    }

    if let Some(subnet) = Cidr::parse(&net.subnet) {
        for h in host {
            if subnet.overlaps(h) {
                out.push(Check::warn(
                    format!(
                        "网络 {} 的子网 {} 和宿主已有的 {} 撞上了",
                        r.network, subnet.raw, h.raw
                    ),
                    "两段叠在一起时，容器访问落在重叠段里的内网地址会被路由到这张 docker 网桥上，表现是「容器起来了但连不上那台机器」——没有报错，最难查的一类".to_string(),
                    format!(
                        "换一张别的网段的网络（避开 {}），或确认 {} 里没有你要访问的机器",
                        h.raw, h.raw
                    ),
                ));
            }
        }
    }

    out
}

/// 端口在清单里的中文名，拿不到就用键名。
fn port_label(spec: &AppSpec, key: &str) -> String {
    spec.ports
        .iter()
        .find(|p| p.key == key)
        .map(|p| p.label.to_string())
        .unwrap_or_else(|| key.to_string())
}

/// 占用者是谁：优先说容器名，其次进程名，都说不上就是"一个宿主进程"。
fn who_is(l: &PortUsage) -> String {
    if let Some(name) = &l.container {
        return name.clone();
    }
    if l.process.is_empty() {
        "一个宿主进程".to_string()
    } else {
        l.process.clone()
    }
}

fn display_addr(l: &PortUsage) -> String {
    if l.address.is_empty() {
        "0.0.0.0".to_string()
    } else {
        l.address.clone()
    }
}

/// 给一个具体的替换建议：从 10000 往上找一个**真能绑上**的端口。
///
/// 上界取临时端口范围的下界，而不是写死 30000 —— 这台机器如果把范围调成了
/// `10000 65535`，建议里就不该再出现临时端口。
fn suggest_ordinary_port(busy: &HashSet<u16>, ephemeral_lo: u16) -> Option<u16> {
    if ephemeral_lo <= 10_000 {
        return None;
    }
    suggest_free(busy, 10_000, ephemeral_lo - 1, 1)
        .first()
        .copied()
}


fn lookup(id: &str) -> Result<AppSpec, AppError> {
    app_catalog::find(id.trim())
        .ok_or_else(|| AppError::not_found(format!("应用市场里没有这个应用：{id}")))
}

/// 校验 + 补齐默认值。
///
/// `plan` 与 `install` 共用同一份 —— 各写一份必然分叉，表现就是"预览说没问题、
/// 一点部署才报错"。
fn resolve(spec: &AppSpec, opts: &InstallOptions) -> Result<Resolved, AppError> {
    let name = opts.name.trim();
    let name = if name.is_empty() {
        spec.default_name.to_string()
    } else {
        name.to_string()
    };
    if !valid_name(&name) || name.len() > MAX_NAME {
        return Err(AppError::bad_request(
            "应用名只能用 a-z 0-9 - _，以字母数字开头，且不超过 41 字符（它同时是目录名和容器名）",
        ));
    }

    let network = opts.network.trim();
    let network = if network.is_empty() {
        DEFAULT_NETWORK.to_string()
    } else {
        network.to_string()
    };
    if !valid_network_name(&network) {
        return Err(AppError::bad_request(format!(
            "不是合法的 docker 网络名：{network}（只用字母数字、- _ . ，以字母数字开头）"
        )));
    }

    let mut ports: Vec<(String, u16, u16)> = Vec::with_capacity(spec.ports.len());
    let mut seen_host: HashMap<u16, String> = HashMap::new();
    for p in &spec.ports {
        let host = opts.ports.get(p.key).copied().unwrap_or(p.host_default);
        if host == 0 {
            return Err(AppError::bad_request(format!("{}不能填 0", p.label)));
        }
        if let Some(other) = seen_host.insert(host, p.key.to_string()) {
            return Err(AppError::bad_request(format!(
                "两个端口都填了 {host}（{other} 与 {}），同一个应用内不能重复",
                p.key
            )));
        }
        ports.push((p.key.to_string(), host, p.container));
    }

    let mut env: Vec<(String, String, bool)> = Vec::with_capacity(spec.env.len());
    for e in &spec.env {
        // 注意：**不 trim 值**。密码里的空格是有意义的，trim 掉就等于悄悄改了
        // 用户设的密码，而且表现为"装好了但连不上"。
        let value = opts
            .env
            .get(e.key)
            .cloned()
            .unwrap_or_else(|| e.default.to_string());

        if value.contains('\n') || value.contains('\r') {
            return Err(AppError::bad_request(format!("{}不能包含换行", e.label)));
        }
        if e.required && value.is_empty() {
            return Err(AppError::bad_request(format!("{}不能为空", e.label)));
        }
        if e.min_len > 0 && !value.is_empty() && value.chars().count() < e.min_len {
            return Err(AppError::bad_request(format!(
                "{}至少 {} 位",
                e.label, e.min_len
            )));
        }
        env.push((e.key.to_string(), value, e.secret));
    }

    // 填了 A 就必须填 B 的搭配关系。
    if let Some((a_key, b_key)) = required_together(spec) {
        let get = |k: &str| {
            env.iter()
                .find(|(key, _, _)| key == k)
                .map(|(_, v, _)| v.clone())
                .unwrap_or_default()
        };
        let (a, b) = (get(a_key), get(b_key));
        if !a.is_empty() && b.is_empty() {
            return Err(AppError::bad_request(format!(
                "填了 {a_key} 就必须填 {b_key}（MySQL 镜像不允许空密码账号）"
            )));
        }
        if a.is_empty() && !b.is_empty() {
            return Err(AppError::bad_request(format!(
                "填了 {b_key} 就必须填 {a_key}"
            )));
        }
    }

    Ok(Resolved {
        name,
        network,
        ports,
        env,
    })
}

/// 「填了 A 就必须填 B」的搭配关系。目前只有 MySQL 的业务账号这一处。
///
/// 用代码而不是清单里的声明式规则：这类字段间约束每多一种形态就得多一层解释器，
/// 为一个应用不值。真出现第三个同类约束时再抽象。
fn required_together(spec: &AppSpec) -> Option<(&'static str, &'static str)> {
    (spec.id == "mysql").then_some(("MYSQL_USER", "MYSQL_PASSWORD"))
}

fn valid_network_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 数据卷的宿主侧必须是部署目录内的相对路径。
///
/// 现在清单是内置的、可信；但这份清单以后要换成用户上传的，那时候绝对路径就是一个
/// "把数据写到容器里任何地方"的口子。边界先立在这儿，以后不用回头补。
fn safe_volume_dir(host: &str) -> Result<String, AppError> {
    let rel = host.trim().trim_start_matches("./");
    let p = std::path::Path::new(rel);
    let bad = rel.is_empty()
        || p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if bad {
        return Err(AppError::bad_request(format!(
            "数据卷路径必须是部署目录内的相对路径：{host}"
        )));
    }
    Ok(rel.to_string())
}

// ── 渲染 ──

/// 渲染 compose。
///
/// 规范照这台机器的既有习惯来（`service::deploy_job` 里那份骨架是同一套）：
/// 接既有内网、`restart: always`、固定时区、json-file 日志轮转。**只是把
/// `build:` 换成 `image:`、把单端口换成按清单来的多端口** —— 基础设施应用没有
/// 构建步骤。
///
/// `mask_secrets` 为真时把机密字段的值换成 `******`，给预览用。
fn render_compose(spec: &AppSpec, r: &Resolved, mask_secrets: bool) -> String {
    let mut s = String::with_capacity(2048);
    s.push_str(&format!(
        "# 由 ZOPS 应用市场生成 —— {} {}\n",
        spec.name, spec.version
    ));
    s.push_str("# 手工改这里不会同步回应用市场的参数；改配置请重新部署，或到「应用与服务」里改脚本。\n");
    s.push_str("services:\n");
    s.push_str(&format!("  {}:\n", r.name));
    s.push_str(&format!("    image: {}\n", spec.image));
    s.push_str(&format!("    container_name: {}\n", r.name));
    s.push_str(&format!("    hostname: {}\n", r.name));
    s.push_str("    restart: always\n");

    if let Some(cmd) = &spec.command {
        s.push_str("    command:\n");
        for part in cmd {
            s.push_str(&format!("      - {}\n", yaml_single(part)));
        }
    }

    s.push_str("    environment:\n");
    s.push_str(&format!("      - TZ={TZ}\n"));
    for (k, v) in &spec.fixed_env {
        s.push_str(&format!("      - {k}={}\n", yaml_single(v)));
    }
    for (key, value, secret) in &r.env {
        let shown = if mask_secrets && *secret {
            "******".to_string()
        } else {
            escape_dollars(value)
        };
        s.push_str(&format!("      - {key}={}\n", yaml_single(&shown)));
    }

    if !spec.volumes.is_empty() {
        s.push_str("    volumes:\n");
        for v in &spec.volumes {
            s.push_str(&format!("      - {}:{}\n", v.host, v.container));
        }
        // 这台机器上其它 compose 都挂它：容器里 `date` 和宿主机是同一个。
        // TZ 环境变量管的是应用自己的时区，两者不重复。
        s.push_str("      - /etc/localtime:/etc/localtime:ro\n");
    }

    if !r.ports.is_empty() {
        s.push_str("    ports:\n");
        for (_, host, container) in &r.ports {
            s.push_str(&format!("      - \"{host}:{container}\"\n"));
        }
    }

    if let Some(hc) = spec.healthcheck {
        s.push_str("    healthcheck:\n");
        s.push_str(&format!(
            "      test: [\"CMD-SHELL\", {}]\n",
            yaml_double(hc)
        ));
        // 一组统一值，不为每个应用微调：start_period 给足 60 秒是为了让"首次启动
        // 要初始化数据目录"的 MySQL/Postgres 不至于一上来就报 unhealthy。
        // 没有任何服务 depends_on 它们，早报 unhealthy 也没有收益。
        s.push_str("      interval: 10s\n");
        s.push_str("      timeout: 5s\n");
        s.push_str("      retries: 12\n");
        s.push_str("      start_period: 60s\n");
    }

    s.push_str("    logging:\n");
    s.push_str("      driver: json-file\n");
    s.push_str(
        "      options: { max-size: \"50m\", max-file: \"10\", compress: \"true\" }\n",
    );
    s.push_str("    networks:\n");
    s.push_str(&format!("      - {}\n", r.network));

    s.push_str("networks:\n");
    s.push_str(&format!("  {}:\n", r.network));
    s.push_str(&format!("    name: {}\n", r.network));
    s.push_str("    external: true\n");
    s
}

/// 安装脚本。
///
/// **没有 `docker build`**：这些都是官方镜像，装 = 拉 + 起。走部署任务通道骨架
/// 那份脚本会因为一句 `docker build` 直接失败（那个 Dockerfile 是等用户传二进制的）。
fn render_script(spec: &AppSpec) -> String {
    format!(
        "# {} {} 的安装脚本（ZOPS 应用市场生成）。\n\
         # 工作目录就是部署目录：compose、数据目录都在这儿。\n\
         # 基础设施应用没有构建步骤：拉镜像、起容器。\n\
         docker compose pull\n\
         docker compose up -d\n\
         docker compose ps\n",
        spec.name, spec.version
    )
}

fn read_marker(dir: &str) -> Option<AppMarker> {
    let text = std::fs::read_to_string(std::path::Path::new(dir).join(MARKER_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// YAML 单引号标量：内部单引号写两遍。
///
/// 用它而不是裸写，是因为密码里出现 `#`、`:`、`'`、前导空格都是常事：裸写的话
/// `#` 之后被当注释吃掉、`:` 可能被当映射键 —— 都是**不报错**地写坏 compose。
/// 单引号标量是 YAML 里唯一"什么字符都能装"的写法。
fn yaml_single(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// YAML 双引号标量。健康检查命令放在 compose 的流式数组里，必须用双引号。
fn yaml_double(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 2);
    out.push('"');
    for ch in v.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// compose 会把自己认得的 `$` 当变量替换掉。用户填的密码里真有个 `$` 是很常见的，
/// 不转义就会被吃成空串 —— 而且**不报错**，只表现为"库起来了但连不上"。
fn escape_dollars(v: &str) -> String {
    v.replace('$', "$$")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(app: &str) -> InstallOptions {
        InstallOptions {
            app: app.to_string(),
            ..Default::default()
        }
    }

    fn with_env(mut o: InstallOptions, key: &str, value: &str) -> InstallOptions {
        o.env.insert(key.to_string(), value.to_string());
        o
    }

    #[test]
    fn required_secret_is_rejected_when_blank() {
        let spec = app_catalog::find("mysql").unwrap();
        let err = resolve(&spec, &opts("mysql")).unwrap_err();
        assert!(format!("{err:?}").contains("root 密码"), "{err:?}");
    }

    /// MinIO 少于 8 位会**直接退出容器**，拦在这里比让用户看到"装好了然后死了"强。
    #[test]
    fn minio_password_has_a_minimum_length() {
        let spec = app_catalog::find("minio").unwrap();
        let short = with_env(opts("minio"), "MINIO_ROOT_PASSWORD", "abc");
        let err = resolve(&spec, &short).unwrap_err();
        assert!(format!("{err:?}").contains("至少 8 位"), "{err:?}");

        let ok = with_env(opts("minio"), "MINIO_ROOT_PASSWORD", "abcdefgh");
        assert!(resolve(&spec, &ok).is_ok());
    }

    /// 默认值必须能"一路回车装出个能用的东西"，所以密码之外要有兜底。
    #[test]
    fn defaults_fill_in_ports_and_env() {
        let spec = app_catalog::find("postgres").unwrap();
        let o = with_env(opts("postgres"), "POSTGRES_PASSWORD", "s3cret");
        let r = resolve(&spec, &o).unwrap();
        assert_eq!(r.name, "postgres");
        assert_eq!(r.network, DEFAULT_NETWORK);
        assert_eq!(r.ports, vec![("postgres".to_string(), 5432, 5432)]);
        let user = r.env.iter().find(|(k, _, _)| k == "POSTGRES_USER").unwrap();
        assert_eq!(user.1, "postgres", "该用清单里的默认值");
    }

    #[test]
    fn custom_name_network_and_port_are_honoured() {
        let spec = app_catalog::find("redis").unwrap();
        let mut o = with_env(opts("redis"), "REDIS_PASSWORD", "pw");
        o.name = "  cache-1  ".to_string();
        o.network = "web".to_string();
        o.ports.insert("redis".to_string(), 16379);
        let r = resolve(&spec, &o).unwrap();
        assert_eq!(r.name, "cache-1", "名字要 trim");
        assert_eq!(r.network, "web");
        assert_eq!(r.ports[0].1, 16379);
    }

    #[test]
    fn bad_names_and_networks_are_rejected() {
        let spec = app_catalog::find("redis").unwrap();
        let base = with_env(opts("redis"), "REDIS_PASSWORD", "pw");

        for bad in ["UPPER", "../escape", "has space", "-lead", "a/b"] {
            let mut o = base.clone();
            o.name = bad.to_string();
            assert!(resolve(&spec, &o).is_err(), "名字 {bad} 应该被拒");
        }

        for bad in ["../etc", "has space", "-lead", "a:b", ""] {
            if bad.is_empty() {
                continue; // 空串是"用默认值"，不是错误
            }
            let mut o = base.clone();
            o.network = bad.to_string();
            assert!(resolve(&spec, &o).is_err(), "网络 {bad} 应该被拒");
        }
    }

    #[test]
    fn duplicate_host_ports_are_rejected() {
        // MinIO 有两个端口，正好用来验"同一应用内不能撞端口"。
        let spec = app_catalog::find("minio").unwrap();
        let mut o = with_env(opts("minio"), "MINIO_ROOT_PASSWORD", "abcdefgh");
        o.ports.insert("api".to_string(), 9100);
        o.ports.insert("console".to_string(), 9100);
        let err = resolve(&spec, &o).unwrap_err();
        assert!(format!("{err:?}").contains("9100"), "{err:?}");
    }

    /// 密码里的 `$` 是真实场景（随机密码生成器最爱用），不转义会被 compose 吃掉。
    #[test]
    fn dollars_in_secrets_are_escaped() {
        assert_eq!(escape_dollars("pa$$w0rd"), "pa$$$$w0rd");
        let spec = app_catalog::find("mysql").unwrap();
        let o = with_env(opts("mysql"), "MYSQL_ROOT_PASSWORD", "a$b");
        let r = resolve(&spec, &o).unwrap();
        let yaml = render_compose(&spec, &r, false);
        assert!(
            yaml.contains("- MYSQL_ROOT_PASSWORD='a$$b'"),
            "compose 里应该是转义后的 a$$b：\n{yaml}"
        );
    }

    /// `#` 和 `'` 不处理就会把 YAML 写坏，而且是**不报错**地写坏。
    #[test]
    fn awkward_characters_are_quoted_safely() {
        assert_eq!(yaml_single("a#b"), "'a#b'");
        assert_eq!(yaml_single("it's"), "'it''s'");
        assert_eq!(yaml_double("say \"hi\""), "\"say \\\"hi\\\"\"");

        let spec = app_catalog::find("postgres").unwrap();
        let o = with_env(opts("postgres"), "POSTGRES_PASSWORD", "a#b'c");
        let r = resolve(&spec, &o).unwrap();
        let yaml = render_compose(&spec, &r, false);
        assert!(yaml.contains("- POSTGRES_PASSWORD='a#b''c'"), "{yaml}");
    }

    /// 预览必须遮住密码：它是给人看、会被复制粘贴的。
    #[test]
    fn preview_masks_secrets_but_the_real_render_does_not() {
        let spec = app_catalog::find("mysql").unwrap();
        let o = with_env(opts("mysql"), "MYSQL_ROOT_PASSWORD", "hunter2");
        let r = resolve(&spec, &o).unwrap();

        let shown = render_compose(&spec, &r, true);
        assert!(shown.contains("- MYSQL_ROOT_PASSWORD='******'"), "{shown}");
        assert!(!shown.contains("hunter2"), "预览里不该出现明文密码");

        let real = render_compose(&spec, &r, false);
        assert!(real.contains("- MYSQL_ROOT_PASSWORD='hunter2'"), "{real}");
        // 非机密字段照常显示 —— 全遮住就没法核对参数了。
        assert!(real.contains("- MYSQL_DATABASE='app'"));
    }

    /// 照这台机器的既有习惯：接 local、自启、时区、日志轮转；**没有 build**。
    #[test]
    fn compose_follows_the_house_conventions() {
        let spec = app_catalog::find("mysql").unwrap();
        let o = with_env(opts("mysql"), "MYSQL_ROOT_PASSWORD", "pw");
        let r = resolve(&spec, &o).unwrap();
        let yaml = render_compose(&spec, &r, false);

        assert!(yaml.contains("image: mysql:8.4"), "{yaml}");
        assert!(!yaml.contains("build:"), "基础设施应用不该有构建步骤：\n{yaml}");
        assert!(yaml.contains("restart: always"), "{yaml}");
        assert!(yaml.contains("- TZ=Asia/Shanghai"), "{yaml}");
        assert!(yaml.contains("max-size"), "要日志轮转：\n{yaml}");
        assert!(yaml.contains("    networks:\n      - local\n"), "{yaml}");
        assert!(yaml.contains("  local:\n    name: local\n    external: true\n"), "{yaml}");
        assert!(yaml.contains("- \"3306:3306\""), "要发布宿主端口：\n{yaml}");
        assert!(yaml.contains("- ./data:/var/lib/mysql"), "{yaml}");
        assert!(yaml.contains("/etc/localtime:/etc/localtime:ro"), "{yaml}");
        // 探活用 $$ 让容器内的 shell 展开，密码值不在命令行里出现。
        assert!(yaml.contains("$$MYSQL_ROOT_PASSWORD"), "{yaml}");
    }

    /// Redis 的密码只能从命令行给，所以要 `sh -c` —— 光写 `$$VAR` 不会展开，
    /// redis 会把 `$REDIS_PASSWORD` 这一串当成密码本身。
    #[test]
    fn redis_command_wraps_itself_in_a_shell() {
        let spec = app_catalog::find("redis").unwrap();
        let o = with_env(opts("redis"), "REDIS_PASSWORD", "pw");
        let r = resolve(&spec, &o).unwrap();
        let yaml = render_compose(&spec, &r, false);

        assert!(yaml.contains("    command:\n      - 'sh'\n      - '-c'\n"), "{yaml}");
        assert!(
            yaml.contains("--requirepass \"$$REDIS_PASSWORD\""),
            "要有 sh 来展开变量：\n{yaml}"
        );
        assert!(!yaml.contains("--requirepass 'pw'"), "密码不该写进命令：\n{yaml}");
    }

    /// MinIO 的命令列表里带 `:9001` 和引号，列表形式下不用任何转义。
    #[test]
    fn minio_command_keeps_its_quoting() {
        let spec = app_catalog::find("minio").unwrap();
        let o = with_env(opts("minio"), "MINIO_ROOT_PASSWORD", "abcdefgh");
        let r = resolve(&spec, &o).unwrap();
        let yaml = render_compose(&spec, &r, false);
        assert!(yaml.contains("- ':9001'"), "{yaml}");
        assert!(yaml.contains("- \"9001:9001\""), "{yaml}");
    }

    #[test]
    fn install_script_has_no_build_step() {
        let spec = app_catalog::find("postgres").unwrap();
        let s = render_script(&spec);
        assert!(s.contains("docker compose up -d"), "{s}");
        assert!(!s.contains("docker build"), "不该有构建步骤：\n{s}");
    }

    #[test]
    fn volume_paths_must_stay_inside_the_deploy_dir() {
        assert_eq!(safe_volume_dir("./data").unwrap(), "data");
        assert_eq!(safe_volume_dir("conf.d").unwrap(), "conf.d");
        for bad in ["/etc", "../data", "a/../../b", ""] {
            assert!(safe_volume_dir(bad).is_err(), "{bad} 应该被拒");
        }
    }

    #[test]
    fn unknown_app_is_not_found() {
        let err = lookup("oracle").unwrap_err();
        assert!(format!("{err:?}").contains("oracle"), "{err:?}");
    }

    // ── 落盘与安装态 ──
    //
    // 这几个跑的是 `prepare()`，不是 `install()`：后半截会真的 `docker compose pull`
    // 拉几百 MB 镜像，测试里不能干那件事。落盘这一半才是要验证的。

    use crate::infrastructure::db::sqlite::Database;
    use crate::infrastructure::docker::DockerClient;
    use crate::service::container::ContainerService;
    use std::path::{Path, PathBuf};

    fn harness(tag: &str) -> (AppMarketService, PathBuf) {
        let db = Arc::new(Database::open(Path::new(":memory:")).unwrap());
        let root = std::env::temp_dir().join(format!("zops-market-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let jobs = Arc::new(DeployJobService::new(db, root.clone()));
        // 这台机器上大概没有 docker socket，`networks()` 会失败 —— 那正好，
        // 网络提醒那条分支本来就是"查不到就不吓唬人"。
        let containers = Arc::new(ContainerService::new(Arc::new(DockerClient::connect())));
        (AppMarketService::new(jobs, containers), root)
    }

    /// 装一份 MySQL，逐项核对落到磁盘上的东西。
    #[test]
    fn install_writes_compose_script_and_marker_without_a_dockerfile() {
        let (svc, root) = harness("mysql");
        let mut o = with_env(opts("mysql"), "MYSQL_ROOT_PASSWORD", "ro0t$pw");
        o.name = "demo-db".to_string();

        let (spec, _, job) = svc.prepare(&o, "tester", "user").unwrap();
        assert_eq!(spec.id, "mysql");
        assert_eq!(job.name, "demo-db");

        let dir = svc.jobs.dir_of("demo-db");
        assert_eq!(dir, root.join("demo-db"));
        assert!(dir.is_dir(), "要建出部署目录");

        let compose = std::fs::read_to_string(dir.join("docker-compose.yml")).unwrap();
        assert!(compose.contains("image: mysql:8.4"), "{compose}");
        assert!(compose.contains("- \"3306:3306\""), "{compose}");
        // 密码原样落盘（`$` 已按 compose 的规则转义），装完能连上才是目的。
        assert!(compose.contains("MYSQL_ROOT_PASSWORD='ro0t$$pw'"), "{compose}");
        // **没有构建步骤**：这是 create_rendered 存在的全部理由。
        assert!(!compose.contains("build:"), "{compose}");

        let script = std::fs::read_to_string(dir.join("deploy.sh")).unwrap();
        assert!(script.contains("docker compose pull"), "{script}");
        assert!(script.contains("docker compose up -d"), "{script}");
        assert!(!script.contains("docker build"), "{script}");

        assert!(
            !dir.join("Dockerfile").exists(),
            "基础设施应用不该有 Dockerfile —— 有的话脚本里的 docker build 会失败"
        );

        // 数据目录要先建出来（挂载点不存在时是 docker 以 root 建的，日志里看不出）。
        assert!(dir.join("data").is_dir(), "要建出 ./data");
        assert!(dir.join("conf.d").is_dir(), "要建出 ./conf.d");

        // 安装标记：面板靠它认领"这个应用装在哪"。
        let marker: AppMarker =
            serde_json::from_str(&std::fs::read_to_string(dir.join(MARKER_FILE)).unwrap()).unwrap();
        assert_eq!(marker.app, "mysql");
        assert_eq!(marker.network, DEFAULT_NETWORK);
        assert_eq!(marker.ports.get("mysql"), Some(&3306));
        // 标记里**不存密码** —— 值在 compose 里，这里只记参数形状。
        let raw = std::fs::read_to_string(dir.join(MARKER_FILE)).unwrap();
        assert!(!raw.contains("ro0t"), "标记文件里不该有密码：{raw}");

        // 部署任务要登记齐三个产物。
        for f in ["docker-compose.yml", "deploy.sh", MARKER_FILE] {
            assert!(
                job.files.iter().any(|x| x.path == f),
                "{f} 应该登记进产物列表：{:?}",
                job.files.iter().map(|x| &x.path).collect::<Vec<_>>()
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 装过之后，列表里那个应用要显示"已安装 + 装在哪 + 实际端口"。
    #[test]
    fn installed_apps_are_recognised_from_the_marker() {
        let (svc, root) = harness("installed");

        let before = svc.list().unwrap();
        assert_eq!(before.len(), 4);
        assert!(before.iter().all(|a| a.installed.is_none()), "一开始都没装");

        let mut o = with_env(opts("redis"), "REDIS_PASSWORD", "pw");
        o.name = "cache-1".to_string();
        o.ports.insert("redis".to_string(), 16379);
        svc.prepare(&o, "tester", "user").unwrap();

        let after = svc.list().unwrap();
        let redis = after.iter().find(|a| a.app_id() == "redis").unwrap();
        let installed = redis.installed.as_ref().expect("redis 应该显示为已安装");
        assert_eq!(installed.name, "cache-1");
        // 卡片要显示**实际**端口而不是默认值，否则用户拿 6379 去连会连不上。
        assert_eq!(installed.ports.get("redis"), Some(&16379));
        assert_eq!(installed.network, DEFAULT_NETWORK);

        // 别的应用不能被误认成已安装（标记是按 app id 认的，不是"有任务就算"）。
        for a in after.iter().filter(|a| a.app_id() != "redis") {
            assert!(a.installed.is_none(), "{} 不该被认成已安装", a.app_id());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 同一个应用装第二份可以（换个名字），但名字撞了要挡住 —— 名字同时是目录名。
    #[test]
    fn a_second_instance_needs_a_different_name() {
        let (svc, root) = harness("dup");
        let o = with_env(opts("postgres"), "POSTGRES_PASSWORD", "pw");
        svc.prepare(&o, "tester", "user").unwrap();

        let again = svc.prepare(&o, "tester", "user").unwrap_err();
        assert!(format!("{again:?}").contains("postgres"), "{again:?}");

        let mut other = with_env(opts("postgres"), "POSTGRES_PASSWORD", "pw2");
        other.name = "postgres-2".to_string();
        other.ports.insert("postgres".to_string(), 15432);
        let (_, r, job) = svc.prepare(&other, "tester", "user").unwrap();
        assert_eq!(job.name, "postgres-2");
        assert_eq!(r.ports[0].1, 15432);

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 方案是只读的：`plan` 不该在磁盘上留下任何东西。
    #[tokio::test]
    async fn plan_touches_nothing() {
        let (svc, root) = harness("plan");
        let o = with_env(opts("minio"), "MINIO_ROOT_PASSWORD", "abcdefgh");

        let plan = svc.plan(&o).await.unwrap();
        assert_eq!(plan.app, "minio");
        assert_eq!(plan.name, "minio");
        assert!(!plan.compose.contains("abcdefgh"), "预览里密码要遮住");
        assert!(plan.compose.contains("******"), "{}", plan.compose);
        assert!(plan.volumes.contains(&"./data".to_string()));

        assert!(!svc.jobs.dir_of("minio").exists(), "plan 不该建目录");
        assert!(svc.list().unwrap().iter().all(|a| a.installed.is_none()));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 部署前检查 ──
    //
    // 真机上的监听表和路由表在测试里造不出来，所以判定逻辑全抽成了纯函数，
    // 这里直接喂假数据把每个分支过一遍。

    fn listener(port: u16, address: &str, process: &str, container: Option<&str>) -> PortUsage {
        PortUsage {
            port,
            address: address.to_string(),
            process: process.to_string(),
            pid: None,
            container: container.map(str::to_string),
        }
    }

    fn network(name: &str, internal: bool, subnet: &str) -> NetworkDto {
        NetworkDto {
            id: "net-id".to_string(),
            name: name.to_string(),
            driver: "bridge".to_string(),
            scope: "local".to_string(),
            internal,
            containers: 0,
            subnet: subnet.to_string(),
        }
    }

    /// 一个宿主端口已经改过的 mysql 参数包。
    fn mysql_on(host_port: u16) -> (AppSpec, Resolved) {
        let spec = app_catalog::find("mysql").unwrap();
        let mut o = with_env(opts("mysql"), "MYSQL_ROOT_PASSWORD", "pw");
        o.ports.insert("mysql".to_string(), host_port);
        let r = resolve(&spec, &o).unwrap();
        (spec, r)
    }

    fn redis_spec_and_resolved(host_port: u16) -> (AppSpec, Resolved) {
        let spec = app_catalog::find("redis").unwrap();
        let mut o = with_env(opts("redis"), "REDIS_PASSWORD", "pw");
        o.ports.insert("redis".to_string(), host_port);
        let r = resolve(&spec, &o).unwrap();
        (spec, r)
    }

    #[test]
    fn 端口被别人的容器占了要挡住() {
        let (spec, r) = mysql_on(3306);
        let live = vec![listener(3306, "0.0.0.0", "docker-proxy", Some("old-mysql"))];
        let checks = port_findings(&spec, &r, &live, &HashMap::new(), None);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Block);
        assert!(checks[0].title.contains("已经被占用"), "{}", checks[0].title);
        // 谁占的、怎么改，都得说出来。只说"被占用"等于把排查丢回给用户。
        assert!(checks[0].detail.contains("old-mysql"), "{}", checks[0].detail);
        assert!(checks[0].fix.contains("old-mysql"), "{}", checks[0].fix);
    }

    #[test]
    fn 端口被自己的旧容器占住时提示先停掉它() {
        let (spec, mut r) = mysql_on(3306);
        r.name = "mysql-1".to_string();
        let live = vec![listener(3306, "0.0.0.0", "docker-proxy", Some("mysql-1"))];
        let checks = port_findings(&spec, &r, &live, &HashMap::new(), None);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Block);
        assert!(checks[0].title.contains("mysql-1"), "{}", checks[0].title);
        assert!(checks[0].fix.contains("停掉"), "{}", checks[0].fix);
        // 不该建议换端口：这是重装，换端口等于留两份数据在机器上。
        assert!(!checks[0].fix.contains("换成别的"), "{}", checks[0].fix);
    }

    #[test]
    fn 同一个端口被_v4_和_v6_各监听一次只报一次() {
        let (spec, r) = mysql_on(3306);
        let live = vec![
            listener(3306, "0.0.0.0", "docker-proxy", Some("old")),
            listener(3306, "::", "docker-proxy", Some("old")),
        ];
        assert_eq!(port_findings(&spec, &r, &live, &HashMap::new(), None).len(), 1);
    }

    #[test]
    fn 落在内核临时端口范围里只报冲突不挡住() {
        let (spec, r) = redis_spec_and_resolved(41234);
        let checks = port_findings(&spec, &r, &[], &HashMap::new(), Some((32768, 60999)));

        assert_eq!(checks.len(), 1);
        // 现在确实能绑上，只是过几天可能被内核占走 —— 拦住用户是错的。
        assert_eq!(checks[0].level, CheckLevel::Warn);
        assert!(checks[0].detail.contains("32768-60999"), "{}", checks[0].detail);
        assert!(checks[0].fix.contains("固定端口"), "{}", checks[0].fix);
    }

    #[test]
    fn 普通端口不会被当成临时端口() {
        let (spec, r) = redis_spec_and_resolved(16379);
        assert!(port_findings(&spec, &r, &[], &HashMap::new(), Some((32768, 60999))).is_empty());
    }

    #[test]
    fn 建议的替换端口落在临时范围之外() {
        let busy = HashSet::new();
        let p = suggest_ordinary_port(&busy, 32768).unwrap();
        assert!((10_000..32768).contains(&p), "{p}");
        // 范围下界低到没有安全区时不硬给数字，免得给出一个同样有问题的建议。
        assert!(suggest_ordinary_port(&busy, 9000).is_none());
    }

    #[test]
    fn 另一个应用声明过的端口只报冲突() {
        let (spec, r) = mysql_on(3306);
        let mut declared = HashMap::new();
        declared.insert(3306u16, "mysql-old".to_string());

        let checks = port_findings(&spec, &r, &[], &declared, None);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Warn);
        assert!(checks[0].detail.contains("mysql-old"), "{}", checks[0].detail);
    }

    #[test]
    fn 自己声明过的端口不算冲突() {
        let (spec, r) = mysql_on(3306);
        let mut declared = HashMap::new();
        declared.insert(3306u16, r.name.clone());
        assert!(port_findings(&spec, &r, &[], &declared, None).is_empty());
    }

    #[test]
    fn 端口已被占用时不再重复报将来的冲突() {
        let (spec, r) = mysql_on(3306);
        let live = vec![listener(3306, "0.0.0.0", "docker-proxy", Some("old"))];
        let mut declared = HashMap::new();
        declared.insert(3306u16, "even-older".to_string());
        let checks = port_findings(&spec, &r, &live, &declared, Some((3000, 4000)));

        // 一个端口三条结论会让人以为有三处问题。只留最要紧的那条。
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Block);
    }

    #[test]
    fn 网络不存在要挡住() {
        let (_, r) = redis_spec_and_resolved(16379);
        let checks = network_findings(&r, None, &[]);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Block);
        // external: true 的语义不是所有人都清楚，detail 里要点出来。
        assert!(checks[0].detail.contains("external"), "{}", checks[0].detail);
    }

    #[test]
    fn 禁止出网的网络要挡住() {
        let (_, r) = redis_spec_and_resolved(16379);
        let net = network(DEFAULT_NETWORK, true, "172.18.0.0/16");
        let checks = network_findings(&r, Some(&net), &[]);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Block);
        assert!(checks[0].detail.contains("拉不到镜像"), "{}", checks[0].detail);
    }

    #[test]
    fn 子网和宿主网段撞上只报冲突() {
        let (_, r) = redis_spec_and_resolved(16379);
        let net = network(DEFAULT_NETWORK, false, "172.17.0.0/16");
        let host = vec![Cidr::parse("172.16.0.0/12").unwrap()];
        let checks = network_findings(&r, Some(&net), &host);

        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].level, CheckLevel::Warn);
        // 两段名字都要出现，否则用户不知道拿哪两段去比。
        assert!(checks[0].title.contains("172.17.0.0/16"), "{}", checks[0].title);
        assert!(checks[0].title.contains("172.16.0.0/12"), "{}", checks[0].title);
    }

    #[test]
    fn 不重叠的网段和没有子网的网络都不报() {
        let (_, r) = redis_spec_and_resolved(16379);
        let host = vec![Cidr::parse("172.16.0.0/12").unwrap()];
        let far = network(DEFAULT_NETWORK, false, "10.9.0.0/16");
        assert!(network_findings(&r, Some(&far), &host).is_empty());

        let blank = network(DEFAULT_NETWORK, false, "");
        assert!(network_findings(&r, Some(&blank), &host).is_empty());
    }

    /// 有阻塞项时 `install` 必须停住。界面会把按钮禁掉，但 MCP 的
    /// `ops_app_install` 是直接调它的 —— 绕过界面的调用同样不该被放行去拉几百 MB
    /// 镜像、再在最后一步失败。
    #[tokio::test]
    async fn 有阻塞项时一键部署会被拒() {
        let (svc, root) = harness("blocked");
        let o = with_env(opts("postgres"), "POSTGRES_PASSWORD", "pw");
        // 先用同一个名字占掉任务名，制造一个必然失败的阻塞项。
        svc.prepare(&o, "tester", "user").unwrap();

        let err = svc.install(&o, "tester", "user").await.unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("部署前检查没通过"), "{msg}");
        assert!(msg.contains("已经有一个叫"), "{msg}");

        // 关键：失败发生在建任务之前，没有留下半个任务。
        let jobs = svc.jobs.list().unwrap();
        assert_eq!(jobs.len(), 1, "只该有先前那一个任务");
        let _ = std::fs::remove_dir_all(&root);
    }
}
