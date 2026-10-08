---
name: zops
description: 通过 ZOPS 面板的 MCP 服务器运维服务器：查看负载、Docker 容器、Caddy 网关、日志与定时任务，并在用户确认后重启容器、重载网关或改 Caddyfile。当用户提到 ZOPS、MCP 里出现 ops_* 工具、或说"服务器变慢/磁盘满/容器挂了/网站 502/证书过期/帮我看看服务器"时使用。
description_zh: 通过 ZOPS 面板运维服务器：查看负载、Docker 容器、Caddy 网关、日志与定时任务，并在用户确认后重启容器、重载网关或改 Caddyfile。
description_en: Operate a Linux server through your own ZOPS panel — inspect load, Docker containers, the Caddy gateway, logs and cron jobs, and restart containers, reload the gateway or edit the Caddyfile once the user approves.
version: 0.2.51
author: Zenceglow
---

# ZOPS

运维面板的 MCP 接口。它把一台服务器的只读观察和受控操作暴露成 `ops_*` 工具。

**先确认能力边界**：调用 `ops_panel_info` 看当前凭证的 `credential_scope`。
`read` 只能看，写操作会返回权限错误；`write` 可以启停容器、重载网关。
如果只读令牌不够用，让用户在面板「MCP」页新建一个 write 令牌。

## 工作方式

1. **只读侦察**。`ops_system_overview` → `ops_container_list` → 针对可疑容器
   `ops_container_logs`。多数问题（磁盘满、内存泄漏、容器反复重启）到这一步就能定性。
2. **给出判断**。把观察到的证据讲清楚：哪个容器、什么错误、从什么时候开始。
3. **提议再动手**。破坏性操作前，说明「做什么、影响什么、怎么回滚」，等用户明确同意。
4. **执行**。
5. **验证**。执行后重新读一次状态或日志，确认问题真的解决了，别只看命令返回值。

## 先核对身份（很重要）

**每一个工具返回里都带 `_host`**：`hostname` / `version` / `started_at` / `machine_id`。

- 开口第一句、以及汇报任何"这台机器"的事实时，先看一眼 `_host`。
- 用户说"服务器"时，他指的可能是另一台 —— 同一套面板可能装在多台机器上。你连的这台
  和用户以为的那台不是一台，报出来的数据全是对的、结论全是错的。
- 版本对不上（用户说 0.2.36、你看到 0.2.24）说明你连的是另一个面板；`started_at`
  不同说明不是同一个进程（中途重启过）。**对不上就别信，先跟用户对齐是哪一台。**
- `credential_scope: read` 的令牌调写工具会报权限错误，那不是故障；让用户在面板
  「MCP」页给这个连接换成 write 令牌。

## 常见任务 → 工具序列

| 用户说 | 你按这个顺序做 |
|---|---|
| 服务器变慢 / 磁盘满 | `ops_system_overview`（看磁盘/内存/负载）→ `ops_deploy_list` 看谁在跑 → 大目录用 `ops_log_tail` 或容器日志定位 |
| 网站 502 / 证书问题 | `ops_gateway_logs`（第一现场）→ `ops_caddyfile_get` 看站点怎么配的 → `ops_port_list` 确认反代目标端口有没有人听 |
| 容器挂了 / 反复重启 | `ops_container_list` 找状态 → `ops_container_logs` 看退出原因 → 修好再 `ops_container_start`（写操作，先说清楚） |
| 帮我看看服务器 | `ops_panel_info` + `ops_system_overview` + `ops_container_list`，给一份"能用的现状"而不是原始 JSON |
| 部署一个服务 | 走下面的**部署任务通道**；先 `ops_deploy_plan` 体检，再 `ops_deploy_job_create` |
| 装个数据库 / 缓存 / 对象存储 | 先 `ops_app_list` 看内置的那几个 → `ops_app_plan` 把 compose 给用户看 → 确认后 `ops_app_install` |
| 加个域名 / 改反代 | `ops_caddyfile_get` 取备份 → `ops_caddyfile_put`（整体替换）→ `ops_gateway_reload` → 用域名实际访问验证 |
| 端口被谁占了 | `ops_port_list`（含进程与容器） |

写操作（`container_start/stop/restart`、`gateway_reload`、`caddyfile_put`、
`automation_task_run`、`deploy_job_run`、`app_install`）**一律先讲清楚「做什么、影响谁、怎么回滚」，
等用户明确同意再调用**。重启容器 = 线上短时中断；`caddyfile_put` 写错 = 全站 502。

> 改完网关配置如果 Caddy 起不来，面板会自动退回上一版 Caddyfile（`.zops-bak`）——
> 你会收到一条"已自动回滚"的错误，那不是把整站搞挂了，是这次改动没生效。

## 工具

| 工具 | 用途 | 需要权限 |
|---|---|---|
| `ops_panel_info` | 面板版本、当前凭证范围、可用工具数 | — |
| `ops_system_overview` | CPU / 内存 / Swap / 磁盘 / 网络 / 负载 / 进程数 | read |
| `ops_port_list` | 正在监听的端口、占用它们的进程或容器，以及几个空端口 | read |
| `ops_container_list` | Docker 容器列表 | read |
| `ops_container_status` | Docker 引擎可用性与版本 | read |
| `ops_container_logs` | 容器最近日志（`tail` 默认 100） | read |
| `ops_gateway_status` | Caddy 状态（runtime / 容器名 / 版本 / 配置文件） | read |
| `ops_gateway_logs` | Caddy 自己的日志（`tail` 默认 300），502 / 证书问题的第一现场 | read |
| `ops_caddyfile_get` | 读取 Caddyfile 原文 | read |
| `ops_log_source_list` | 已登记的日志文件路径 | read |
| `ops_log_tail` | 读某个日志文件末尾若干行 | read |
| `ops_notify_channel_list` | 已配置的通知渠道及订阅的事件 | read |
| `ops_deploy_list` | 这台机器上部署过哪些服务 | read |
| `ops_deploy_plan` | 部署体检（端口 / 重启 / 日志 / 时区 / 网络 / 凭据） | read |
| `ops_container_start` / `_stop` / `_restart` | 启停容器 | **write** |
| `ops_gateway_reload` | 重载 Caddy | **write** |
| `ops_caddyfile_put` | 整体替换 Caddyfile（不自动重载） | **write** |
| `ops_automation_task_list` / `_run` | 列定时任务 / 立刻执行 | **write** |
| `ops_member_list` | 面板成员与权限 | **write** |
| `ops_notify_send` | 往订阅了该事件的渠道推一条通知 | **write** |
| `ops_deploy_apply` | 写部署目录并 `docker compose up -d --build` | **write** |
| `ops_deploy_job_list` / `_get` | 部署任务列表 / 详情（脚本、产物、记录） | read |
| `ops_deploy_job_create` | 建部署任务（= 建 `/opt/docker-apps/<name>/` 目录） | **write** |
| `ops_deploy_job_put_file` / `_put_script` | 写文本产物 / 写部署脚本 | **write** |
| `ops_deploy_job_run` | 执行部署脚本 | **write** |
| `ops_deploy_job_log` | 增量拉部署日志（进度） | read |
| `ops_app_list` | 应用市场里的内置应用（镜像、默认端口、要填的环境变量、数据卷、是否已装） | read |
| `ops_app_plan` | 渲染安装方案（compose 预览、脚本、数据目录、端口/网络提醒），不改任何东西 | read |
| `ops_app_install` | 一键部署一个内置应用（写 compose、起容器） | **write** |

## 应用市场

内置了四个「一键部署」的应用：**MySQL 8.4、PostgreSQL 17、Redis 7、MinIO**。
它们都是官方镜像，**没有构建步骤**，装 = 渲染 compose + `docker compose up -d`。

和部署任务通道的关系：**应用市场是预置好的部署任务**。装完之后它就是一个普通的部署
任务（目录、脚本、记录、日志全在 `/deploy/job/*` 那一套里），所以排查、重跑、看日志
用的还是同几个工具。安装时会往部署目录写一个 `.zops-app.json`，标记"这是市场装的哪个
应用、当时的端口和网络"，面板靠它认领安装态。

顺序：`ops_app_list` → `ops_app_plan` → **给用户看 compose 和端口** → 用户确认 →
`ops_app_install` → `ops_deploy_job_log` 拉进度。

几条要点：

- **端口**：`ops_app_plan` 会告诉你默认端口有没有被占。撞了就换一个 —— 别硬装，
  `bind: address already in use` 只会体现在容器起不来。
- **网络**：默认接 `local`，这台机器上其它容器都在这个内网里，按容器名就能互相连。
  要跨机或隔离才改。
- **密码**：`env` 里标了 required 的都是密码，必须让用户自己给，**不要替他编一个**
  —— 编完就得转述给他，还会留在对话里。MinIO 的密码最少 8 位，少了容器直接退出。
- **首次启动慢**：MySQL / PostgreSQL 要初始化数据目录，二十到六十秒，这期间探活是
  `unhealthy`，别当成装坏了。
- **`ops_app_plan` 里的密码是遮住的**（`******`），这是给用户看的预览，不是真值。

## 部署任务通道

要部署东西，**优先走部署任务通道**（`ops_deploy_job_*`），它和面板「部署」页是同一批
记录：谁在什么时候部署了什么、结果如何、绑到哪个容器，事后都查得到。顺序是
`create` → `put_file`（二进制产物用 `curl -T` 打 `/api/ops/deploy/job/upload`）→
`put_script` → 用户确认 → `run` → `log` 拉进度。

部署脚本的写法、端口/网络/日志/反代的既有习惯、以及 Dockerfile 与 compose 的参考
模板，都在 `skill://zops/references/deploy`（resources 里可以直接读）。

技能包本身挂在 MCP `resources` 上：`resources/list` 能看到
`skill://zops/SKILL.md`、`skill://zops/references/deploy`、
`skill://zops/references/troubleshooting`，`resources/read` 读正文 —— 建好连接就能读，
不用另外装技能目录。

## 破坏性操作

这几条会改变线上状态，**执行前必须让用户确认**：

- `ops_container_stop` / `ops_container_restart` —— 会中断该容器提供的服务。
  重启 `caddy` 等于全站短暂 502；重启数据库容器可能让上游报错。
- `ops_caddyfile_put` —— 整体替换配置，写错会让**所有**域名 502。
  改之前先 `ops_caddyfile_get` 拿一份原文，改完再 `ops_gateway_reload` 并验证站点。
- `ops_gateway_reload` —— 配置有语法错误时 Caddy 会拒绝加载（这是好事），
  但要告诉用户当前是哪一份配置在生效。
- `ops_automation_task_run` —— 在服务器上直接跑 shell 命令，先看清楚 `command` 是什么。

## 输出怎么读

工具返回 JSON 文本。几个容易看错的地方：

- 容器用**名字**或 ID 都可以，优先用名字（`caddy`、`zenceglow-web`）。
- `ops_system_overview` 的内存含 buff/cache，判断"内存不够"要看 available 而不是 free。
- `ops_gateway_status.runtime` 是 `docker` 时，Caddy 跑在容器里，
  `caddyfile_path` 是**宿主机**上的那份（容器内是 `/etc/caddy/Caddyfile`）。
- `ops_gateway_logs` 返回 `available: false` 时不要当成"日志是空的"：它在告诉你
  没找到 Caddy 的输出，具体原因和下一步写在 `hint` 里，照做就行。
- `isError: true` 表示工具调用失败（通常是权限或参数），不是服务器故障。

## 排障剧本

常见故障的分步处置见 `references/troubleshooting.md`：
磁盘满、容器反复重启、网站 502、证书签发失败、内存吃紧、Caddyfile 改坏回滚。

## 部署剧本

用户说"把这个项目部署上去"时看 `references/deploy.md`。核心是**别再手写 Docker
配置**：这台机器上端口区间、网络、日志、反代都有既定习惯，先 `ops_port_list`
挑一个空端口，照那份文档里的模板生成 compose，起来之后验证、接网关、最后
`ops_notify_send` 通知一声。

两条硬规矩：

1. **所有操作都经过 ZOPS。** 不要 SSH、不要在服务器上直接敲 docker。工具不够用
   就停下来告诉用户缺什么。
2. **能自己解决的不问用户。** 缺 restart、日志轮转、时区、网络这些，按既有风格
   自己补上；只有会导致生产事故、或者只有用户能决定的事才停下来问，并且要带上
   "可以忽略"这个选项。

## 不要做的事

- 不要在未经确认时停止或重启容器、改 Caddyfile、跑定时任务。
- 不要用 `ops_caddyfile_put` 做"顺手的小修改"——它是整体替换，用完整原文改。
- 不要把 token 明文写进代码、日志或聊天记录里；它只在面板创建时显示一次。
- 面板只管这台服务器。别假设它能看到集群里的其他机器。
