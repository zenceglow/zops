---
name: zops
description: 通过 ZOPS 面板的 MCP 服务器运维服务器：查看负载、Docker 容器、Caddy 网关、日志与定时任务，并在用户确认后重启容器、重载网关或改 Caddyfile。当用户提到 ZOPS、MCP 里出现 ops_* 工具、或说"服务器变慢/磁盘满/容器挂了/网站 502/证书过期/帮我看看服务器"时使用。
---

# ZOPS

运维面板的 MCP 接口。它把一台服务器的只读观察和受控操作暴露成 `ops_*` 工具。

**先确认能力边界**：调用 `ops_panel_info` 看当前凭证的 `credential_scope`。
`read` 只能看，写操作会返回权限错误；`write` 可以启停容器、重载网关。
如果只读令牌不够用，让用户在面板「接入 Codex」页新建一个 write 令牌。

## 工作方式

1. **只读侦察**。`ops_system_overview` → `ops_container_list` → 针对可疑容器
   `ops_container_logs`。多数问题（磁盘满、内存泄漏、容器反复重启）到这一步就能定性。
2. **给出判断**。把观察到的证据讲清楚：哪个容器、什么错误、从什么时候开始。
3. **提议再动手**。破坏性操作前，说明「做什么、影响什么、怎么回滚」，等用户明确同意。
4. **执行**。
5. **验证**。执行后重新读一次状态或日志，确认问题真的解决了，别只看命令返回值。

## 工具

| 工具 | 用途 | 需要权限 |
|---|---|---|
| `ops_panel_info` | 面板版本、当前凭证范围、可用工具数 | — |
| `ops_system_overview` | CPU / 内存 / Swap / 磁盘 / 网络 / 负载 / 进程数 | read |
| `ops_container_list` | Docker 容器列表 | read |
| `ops_container_status` | Docker 引擎可用性与版本 | read |
| `ops_container_logs` | 容器最近日志（`tail` 默认 100） | read |
| `ops_gateway_status` | Caddy 状态（runtime / 容器名 / 版本 / 配置文件） | read |
| `ops_caddyfile_get` | 读取 Caddyfile 原文 | read |
| `ops_log_source_list` | 已登记的日志文件路径 | read |
| `ops_log_tail` | 读某个日志文件末尾若干行 | read |
| `ops_container_start` / `_stop` / `_restart` | 启停容器 | **write** |
| `ops_gateway_reload` | 重载 Caddy | **write** |
| `ops_caddyfile_put` | 整体替换 Caddyfile（不自动重载） | **write** |
| `ops_automation_task_list` / `_run` | 列定时任务 / 立刻执行 | **write** |
| `ops_member_list` | 面板成员与权限 | **write** |

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
- `isError: true` 表示工具调用失败（通常是权限或参数），不是服务器故障。

## 排障剧本

常见故障的分步处置见 `references/troubleshooting.md`：
磁盘满、容器反复重启、网站 502、证书签发失败、内存吃紧、Caddyfile 改坏回滚。

## 不要做的事

- 不要在未经确认时停止或重启容器、改 Caddyfile、跑定时任务。
- 不要用 `ops_caddyfile_put` 做"顺手的小修改"——它是整体替换，用完整原文改。
- 不要把 token 明文写进代码、日志或聊天记录里；它只在面板创建时显示一次。
- 面板只管这台服务器。别假设它能看到集群里的其他机器。
