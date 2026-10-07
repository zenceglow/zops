# ZOPS 支持 Windows：改动评估

> 目标：**ZOPS 装在 Windows 上，管理它自己这台机器**（不是从 Linux 面板去管远程 Windows）。
> 评估日期 2026-10-07，对应版本 0.2.50。

## 一、结论

**这不是"移植"，但也远不是"重写一半产品"。**

- 前端 19,887 行 —— **零改动**（全项目 grep 不到一处 `navigator.platform` / `win32` 判断）。
- Rust 21,222 行里，**57%（12,027 行 / 63 个文件）本来就跨平台**，一行不用动。
- 真正需要重写的平台绑定代码约 **4,500 行**，且集中在少数几个文件里。
- 需要新增：一个平台抽象层（~800 行）、一套 Windows 实现（~2,500 行）、`install.ps1` + 服务封装（~600 行）。

**量级：新增/重写约 3,500～4,500 行，重构约 1,500～2,000 行。** 相比整体规模，大约是"再做一个平台后端子系统"，不是"再写一遍 infrastructure"。

## 二、现状盘点

### 2.1 意外地干净

| 项 | 事实 | 含义 |
|---|---|---|
| 运行时 OS 判断 | **0 处**（`target_os` / `env::consts::OS` / `cfg!(unix)` 全无） | 代码从不分支，只是假定 Linux —— 连接缝都要现搭 |
| `libc::` | 0 处 | 没有裸系统调用 |
| `nix::` | 6 处 | 可忽略 |
| `std::os::unix` / `PermissionsExt` | 6 / 4 处 | 集中在 4 个文件 |
| `cfg(unix)` | 5 处 | —— |
| Linux 耦合点 | 105 处，散布 30 个文件 | 密度极低，多数文件只有 1–2 处 |

### 2.2 依赖都是跨平台的

`sysinfo`（采集）、`bollard`（Docker）、`rusqlite`+`bundled`（SQLite）、`russh`（SSH 客户端）、
`portable-pty`（ConPTY 支持 Windows）、`axum`/`tokio`/`serde`/`rust-embed` —— **全部支持 Windows**。
没有 `nix`、没有硬编码 socket 路径。

### 2.3 已经可以原样复用的部分

- HTTP 层（`src/http/`，4,249 行）、认证/JWT、权限、成员、审计
- SQLite（`db/sqlite.rs`，2,537 行 —— 最大的单文件）、配置读写
- 通知渠道（飞书/钉钉/企微/Slack/Discord/Telegram/Webhook）
- MCP server（`handlers/mcp.rs`，1,258 行）+ 技能包
- 文件浏览、日志 tail 读取器、geoip、S3
- **Docker（1,145 行）** —— bollard 走 HTTP API，Windows 上换命名管道连接即可
- **Caddy 的编辑逻辑**（见 2.4）

### 2.4 一个关键的好消息：Caddy 只绑定了一半

Caddy 网关看起来是最大的 Linux 绑定（2,312 行），但拆开看：

| 文件 | 行数 | 平台相关？ |
|---|---|---|
| `domain/caddy.rs` | 372 | ❌ 纯文本处理（`# ZOPS:BEGIN/END` 标记块、增删改站点） |
| `service/caddyfile.rs` | 187 | ❌ 只是调用上面的纯函数 |
| `infrastructure/caddy/fmt.rs` | 169 | ❌ 只是 `caddy fmt/validate --config -` 走 stdin |
| `infrastructure/caddy/install.rs` | 275 | ✅ GitHub 拉包 + 写 systemd unit |
| `infrastructure/caddy/process.rs` | 362 | ✅ systemctl / pkill / 信号 |
| `infrastructure/caddy/bin.rs` | 90 | ✅ `/proc/<pid>/cgroup` 判断容器进程 |
| `infrastructure/caddy/logs.rs` + `access.rs` | 520 | ⚠️ 只绑定日志路径 |

**约 730 行的 Caddyfile 编辑内核可以直接复用**，要重写的只有"装"和"起"两层。
Caddy 官方提供 Windows zip，`caddy.exe` 同样支持 `validate` / `reload`。

顺带一提：`bin.rs` 里已经有一句「读不到 cgroup（非 Linux）时不作过滤，退回老行为」——
作者已经局部考虑过非 Linux。

## 三、要新增的：平台抽象层

现在全项目**没有任何 OS 分支**，所以第一步是立一层显式的边界，而不是到处撒 `#[cfg]`。

```rust
// src/platform/mod.rs
pub trait HostPlatform: Send + Sync {
    fn service_install(&self, spec: &ServiceSpec) -> Result<()>;
    fn service_control(&self, action: ServiceAction) -> Result<()>;
    fn service_state(&self) -> Result<ServiceState>;

    fn machine_id(&self) -> Option<String>;
    fn paths(&self) -> HostPaths;                    // 数据目录 / 日志根 / 网关配置路径

    fn listening_ports(&self) -> Result<Vec<PortBinding>>;
    fn scheduled_tasks(&self) -> Result<Vec<ScheduledTask>>;
    fn system_updates(&self) -> Result<UpdateReport>;
    fn security_events(&self, since: DateTime<Utc>) -> Result<Vec<SecurityEvent>>;
}

#[cfg(unix)]    pub use linux::LinuxHost    as Current;
#[cfg(windows)] pub use windows::WindowsHost as Current;
```

两个实现，编译期择一。上层（`service/`、`http/`）只认 trait。

## 四、分阶段计划

### 阶段 0 —— 抽象层（前置，约 800 行）

1. 新增 `src/platform/`，把现有 Linux 逻辑**原样搬进去**（不加功能，只搬），保证 `cargo test` 仍全绿。
2. `config.rs`（69 行）从纯环境变量改成 **环境变量 + 配置文件**。
   Windows 服务没有 systemd 的 `Environment=`，`OPS_PORT` / `CADDYFILE_PATH` / `OPS_DEPLOY_DIR`
   这些现在全写在 unit 文件里。顺带这也是个改进 —— Linux 那边也能少依赖 unit。
3. `shared/panel.rs` 的机器指纹（`/etc/machine-id`）抽成 `machine_id()`。
   Windows 用注册表 `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`。
4. `domain/logs.rs` 的 `ALLOWED_PREFIXES`（硬编码 `/var/log/` `/opt/docker-apps/`）改成由 platform 提供。

### 阶段 1 —— 能装、能自启、能更新（最小可用，约 1,200 行）

| 事项 | 现在 | Windows 实现 |
|---|---|---|
| 服务化 | systemd unit + `enable` | Windows SCM（`windows-service` crate 自写 dispatcher，或 WinSW/NSSM 包一层） |
| 安装 | `install.sh`（776 行 bash） | `install.ps1`：下载 → 校验 → 装到 `%ProgramData%\ZOPS` → 注册服务 → 首启 |
| 版本清单 | `latest.json` + `install.sh` URL | 同一份 CDN 清单，按 `platform` 字段分流产物 |
| CLI（`cli.rs` 566 行） | 读 unit 拿端口/数据目录 | 读配置文件 + 服务状态 |
| 构建 | `cargo zigbuild --target x86_64-unknown-linux-gnu` | 加 `x86_64-pc-windows-msvc`（CI 装 VS Build Tools） |

**自更新的坑见第五节。**

### 阶段 2 —— 核心页面真的能用（约 1,000 行）

| 页面 | 现状 | 改动 |
|---|---|---|
| 首页/监控 | `sysinfo` | ✅ 直接可用（Swap → 页面文件，磁盘 → 盘符） |
| Docker | bollard + `docker` CLI | ✅ 换 npipe 连接；CLI 用 `docker.exe` |
| 文件 | 根目录、`/proc /sys /dev /run` 黑名单 | 根改盘符；黑名单换 `C:\Windows\System32\config` 等 |
| 日志查看器 | 前缀白名单 | 由 platform 提供；新增 Windows 事件日志来源 |
| SSH 终端 | `portable-pty` | ✅ ConPTY；默认 shell 换 PowerShell |
| 端口/网络 | `ss` | `netstat -ano` / `Get-NetTCPConnection` |
| 定时任务 | systemd timer | 任务计划程序（`schtasks`） |
| 通知/成员/审计/MCP | —— | ✅ 零改动 |

### 阶段 3 —— 要么重做、要么砍（约 1,500 行）

| 功能 | 行数 | 决定 |
|---|---|---|
| Caddy 网关（装+起） | ~730 | 重做；编辑内核复用 |
| 安全中心 | 550 | 重做：解析 `/var/log/auth.log` → Windows 事件日志（4625 失败 / 4624 成功登录） |
| 服务器页：补丁 | 316 | `apt`/`dnf` → `winget upgrade` |
| 服务器页：时区 | 125 | `timedatectl` / `/etc/localtime` → `tzutil` |
| 服务器页：DNS | 175 | systemd-resolved → `netsh interface ip set dns` |
| 服务器页：VPN | 186 | `wg` → WireGuard Windows（`wg.exe` 有，服务模型不同） |
| 服务器页：虚拟内存 / 垃圾清理 | —— | 页面文件；临时目录 |
| 部署通道 | 1,382 | 语义要重新定义（见第六节） |

## 五、三个 Windows 特有的坑

### 5.1 自更新会正面撞上 Windows 的文件锁

现在是「rename 覆盖二进制 + `systemctl restart`」（`selfupdate.rs` 662 行）。
**Windows 不允许替换正在运行的 `.exe`** —— 文件被独占锁住，rename 直接失败。

可行的做法：现在的代码其实已经用了一个"替身"思路（`hostctl.rs:189` 用 `systemd-run`
起一个独立单元，避免被本服务的 cgroup 连带杀掉）。Windows 版的对应形态：

1. 下载新版到 `%ProgramData%\ZOPS\pending\zops.exe`
2. 起一个**分离的** updater 进程（`DETACHED_PROCESS`），或注册一个一次性计划任务
3. 主进程退出 → updater 等文件锁释放 → 替换 exe → `sc start zops`
4. 或用 SCM 的失败恢复策略自动拉起

**这块约 200 行要重写逻辑，不是换命令。**

### 5.2 路径语义：别用字符串前缀判断路径

现在有多处字符串前缀比较（`domain/logs.rs` 的白名单、`files.rs` 的黑名单）。
Windows 上：反斜杠、盘符、大小写不敏感、UNC 路径（`\\server\share`）、
以及 `C:\foo\..\bar` 这类不规范形式。这些判断要改用 `PathBuf` / `Path::starts_with`，
不能继续拼字符串。

### 5.3 配置不再有 unit 文件兜底

`cli.rs` 的 `zops info` / `update` / `uninstall` / `access` 现在全靠在 unit 文件里
读写 `Environment=OPS_PORT` / `OPS_BIND`。Windows 服务改环境变量要走注册表或服务配置，
很别扭 —— 所以阶段 0 的配置文件改造是**前置必需**，不是可选优化。

## 六、部署通道要重新想清楚

`service/deploy.rs`（593）+ `deploy_job.rs`（789）是面板的三大卖点之一，
建立在「这台机器上跑了二十来个服务，端口怎么分、网络怎么连、日志怎么转、反代怎么写」
这套 Linux/Docker Compose 习惯上。

Windows 上它依然能跑（Docker Desktop + compose），但有两个真问题：

1. **Docker Desktop 的授权与场景** —— 它是桌面产品，不是服务器容器运行时；
   商用授权也和生产环境不一样。
2. **反代那一段** —— 部署剧本里最后一步是写 Caddy 站点，Windows 上这一步要不要保留、
   用 Caddy 还是 IIS，需要单独定。

**建议**：阶段 3 之前先决定部署通道在 Windows 上到底保留多少。如果砍掉，
整体工作量能少 1,000 行以上。

## 七、建议的第一步

不要一上来就 `#[cfg(windows)]` 铺开。按这个顺序：

1. **先做阶段 0（抽象层）**，且**不合并 Windows 实现** —— 把 Linux 逻辑原样搬进
   `platform/linux/`，让 77 个测试全绿。这一步纯重构，风险低，且立刻让"哪些代码其实
   是平台相关"变得可见。
2. 然后**只做阶段 1 + 阶段 2 的只读部分**（能装、能自启、首页/Docker/日志/文件/端口可用），
   发布一个 Windows 预览版，用它自己盯自己。
3. 阶段 3 按上面的表逐个决定"重做还是砍"。

这个顺序的好处是：**前两步做完就已经是个有用的产品**（"agent 能看见这台 Windows 机器上的
容器、日志、端口"），而且阶段 3 里那几个重活（Caddy / 安全中心 / 补丁）
可以按实际需求再排期，不用卡在关键路径上。
