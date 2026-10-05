# 排障剧本

每个剧本都用面板的 `ops_*` 工具。步骤里标注了哪些是只读、哪些需要用户确认。

## 1. 磁盘满

**症状**：写入失败、容器起不来、`ops_system_overview` 里 disk 使用率接近 100%。

1. `ops_system_overview` —— 确认是哪个挂载点满（`/` 常见，`/data` 另外算）。
2. `ops_container_list` —— 找日志写得很凶的容器（nginx/caddy/应用）。
3. `ops_container_logs` 看是否在刷错误日志（放大循环会迅速吃满磁盘）。
4. 候选处置（**都要先确认**）：
   - 清 Docker 悬空资源前先看占用：`docker system df`（需要 SSH/终端，不在 MCP 里）。
   - 轮转/截断容器日志，或给 Caddy 配 `roll_size` / `roll_keep`。
   - 重启刷日志的容器只是止血，要找到刷日志的根因。

## 2. 容器反复重启

1. `ops_container_list` —— 看 `status` 里的 `Restarting` / `Exited (1)`。
2. `ops_container_logs`（`tail` 开到 200–500）—— 找最后一屏堆栈。
3. 常见原因：配置写坏了（Caddyfile/环境变量）、端口被占、依赖容器没起来、
   卷权限不对。
4. **确认后**再 `ops_container_restart`；如果启动即崩，重启没用，先改配置。

## 3. 网站 502

Caddy 反代到某个上游，上游挂了就是 502。

1. `ops_gateway_status` —— 确认 Caddy 在跑（runtime=docker 时看容器状态）。
2. `ops_gateway_logs` —— Caddy 自己会写明是"dial tcp: connection refused"还是
   在等上游超时，比只看 502 直接省掉一半猜测。（返回 `available: false` 时读 `hint`。）
3. `ops_caddyfile_get` —— 找到该域名的 `reverse_proxy` 目标（例如 `zenceglow-web:80`）。
4. `ops_container_list` —— 看上游容器在不在、是不是 Exited。
5. `ops_container_logs` —— 看上游为什么挂了。
6. **确认后**启动/重启上游，再刷新页面验证。

## 4. 证书签发失败

1. `ops_gateway_logs`（`tail` 开到 500）—— 搜 `acme` / `challenge` / `obtain`。
   docker 模式下它等于 `ops_container_logs` 的 caddy 容器日志。
2. 常见原因：80 端口被别的进程占用（ACME HTTP-01 需要 80）、DNS 没解析到本机、
   域名被墙/被限流（Let's Encrypt 有速率限制，反复失败会锁一段时间）。
3. 确认 80 端口归属：`ops_container_list` 看端口映射有没有冲突。
4. **确认后** `ops_gateway_reload` 重试；连续失败不要反复重载，先修 DNS/端口。

## 5. 内存吃紧

1. `ops_system_overview` —— 看 available（不是 free）。buff/cache 可回收，不算紧张。
2. `ops_container_list` + `ops_container_logs` —— 找内存持续增长的容器。
3. OOM 会体现在内核日志和容器退出码 137；`ops_log_tail` 指到 `/var/log/messages`
   或 `dmesg` 落盘文件可以确认。
4. **确认后**重启该容器；如果是泄漏，提醒用户加内存上限（`--memory`）并修代码。

## 6. Caddyfile 改坏要回滚

`ops_caddyfile_put` 是整体替换，改坏了站点会直接 502。

1. 如果你在改之前存过原文，直接 `ops_caddyfile_put` 回原文。
2. 没存过：`ops_caddyfile_get` 看当前（坏的）内容，定位语法错误再修——
   `ops_gateway_reload` 会返回 Caddy 的语法错误信息，照它改。
3. 兜底：宿主机上通常有容器挂载目录的历史副本，或 `caddy` 容器内 `/data` 里的
   自动保存配置（需要终端，请让用户协助）。
4. 改完务必 `ops_gateway_reload` + 实际访问域名验证，不要只看返回成功。
