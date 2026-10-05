# 部署剧本

用户说"把这个项目部署上去"时照这个走。目标只有一个：**别再手写 Dockerfile 和
compose** —— 这台机器上已经跑了二十来个服务，端口怎么分、网络怎么连、日志怎么
转、反代怎么写，全都有既定习惯，照着抄一遍就行。

## 〇、铁律：所有操作都经过 ZOPS

**不要 SSH 上去、不要在服务器上直接敲 docker、不要绕过面板改文件。**

这不是洁癖：走 ZOPS 的动作会进审计日志（谁在什么时候把什么改成什么样），
而绕过面板做的改动，出了问题没人查得到是从哪来的。面板已经把需要的能力都
开出来了，用它就行：

| 要做的事 | 用哪个工具 |
|---|---|
| 看端口占用、挑空端口 | `ops_port_list` |
| 看已部署的服务、容器 | `ops_deploy_list` / `ops_container_list` |
| 部署体检 | `ops_deploy_plan` |
| 落地并起服务 | `ops_deploy_apply` |
| 看日志排障 | `ops_container_logs` / `ops_gateway_logs` / `ops_log_tail` |
| 启停重启 | `ops_container_start` / `_stop` / `_restart` |
| 改网关配置 | `ops_caddyfile_get` → `ops_caddyfile_put` → `ops_gateway_reload` |
| 通知一声 | `ops_notify_send` |

工具不够用（比如要跑一个 ZOPS 没有的动作），**停下来告诉用户缺什么**，不要
自己想办法绕过去。

## 一、先看现状，别拍脑袋

1. `ops_port_list` —— 谁占了哪些端口，还空着哪几个。**部署前必跑这一条**。
2. `ops_deploy_list` + `ops_container_list` —— 已经部署过什么、跑着什么。
3. `ops_caddyfile_get` —— 现有站点怎么写的。最新的那一段就是模板，别自创格式。
4. `ops_system_overview` —— 磁盘还够不够。不够就先说，别部署到一半失败。

## 二、体检：先 `ops_deploy_plan`，再 `ops_deploy_apply`

`ops_deploy_plan` 会拿你准备写下去的那份 compose 做一遍检查，结论分三档：

- **block** —— 必须先解决，`ops_deploy_apply` 会直接拒绝。目前有两类：端口被占、
  服务名或文件路径不合法。端口冲突时它会给几个空端口，换了再提交。
- **warn** —— 该处理，但不拦路：缺 `restart`、缺日志出口、缺 `TZ`、没接 `local`
  网络、明文写死的凭据、没有 healthcheck。**每条都带了能直接抄的片段。**
- **ok** —— 没问题。

处理原则（用户明确要求过）：

> **能自己解决的不要问用户。** warn 里的 restart / 日志轮转 / 时区 / 网络这四项，
> 按下面第三节的既有风格补上就行，不要为它们去打断用户。补完重新 plan 一次。

## 三、生产必备要素：这些 ZOPS 看不到，归你

体检工具只能看 compose 本身，看不到项目源码。下面这些要在**项目仓库里**确认，
缺了要提醒用户 —— 但要说清"可以忽略"，决定权在他：

| 要素 | 怎么判断 | 缺了怎么办 |
|---|---|---|
| 日志策略 | Java 看有没有 `logback-spring.xml`/`log4j2.xml` 里的滚动策略（`RollingFileAppender` + `maxHistory`）；Go/Node 看有没有按大小切分 | 提醒用户：容器 `json-file` 轮转只兜住 stdout，应用自己写的文件不轮转会撑爆磁盘。**能加就自己加一份合理的默认配置**，别只报问题 |
| 生产配置 | 有没有 `config-prod.*` / `.env.production` / `application-prod.yml`，以及它是否被挂载进容器 | 提醒用户，并说明现在会跑默认（通常是 dev）配置 |
| 数据库迁移 | 有没有 migration/seed 步骤需要先跑 | 提醒用户，别让服务起来后表不存在 |
| 健康检查端点 | 有没有 `/health` 之类 | 有就写进 healthcheck；没有就在 warn 里说明，不硬造 |
| 静态资源路径 | 前端构建产物目录对不对（`out` / `dist` / `.next/standalone`） | 自己确认，不用问 |
| 密钥来源 | 是 `.env` 还是明文 | 明文一律改成 `${{VAR}}` + 同目录 `.env`，**这属于能自己解决的** |

提醒用户时的说法要具体：**缺什么、会导致什么、可以忽略**。不要问"你要不要加日志
策略"这种开放问题，直接说"没看到日志滚动配置，我按 100MB × 7 份加了一份，你要是有
自己的规范覆盖掉就行"。

## 四、这台机器的既有习惯

| 事项 | 习惯 |
|---|---|
| 部署目录 | `/opt/docker-apps/<服务名>/` |
| 容器名 / 镜像名 | 就是服务名（`zenceglow-server`），只在本机构建，不推仓库 |
| 网络 | 外部网络 `local`；有的项目用专属网络（如 `yueqixing`） |
| 时区 | `TZ=Asia/Shanghai` |
| 重启策略 | `restart: always` |
| 日志 | `logging: json-file`，`max-size: 50m`，`max-file: 10`，`compress: true` |
| 前端 | 构建成静态文件 → `caddy:alpine` 或 node standalone → **不发布宿主端口**，由网关按容器名反代 |
| 后端 | 发布一个宿主端口 → 网关反代 `localhost:<端口>` |
| 数据 | 命名卷，或 `./data`、`./logs`、`./configs` 目录挂载 |
| 健康检查 | 有 `/health` 就加 `healthcheck`，没有就跳过 |

端口是这套部署里唯一会冲突的资源，所以**只从 `ops_port_list` 的 `suggested` 里挑**，
不要自己编一个。8000-9999 是既有区间。

## 五、步骤

### 1. 定端口

`ops_port_list` 的 `suggested` 就是空着的，直接取第一个。要把端口告诉用户 ——
它是要写进网关配置的。

### 2. 写 Dockerfile（项目里没有才写）

后端二进制：

```dockerfile
FROM alpine:3.20
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup \
    && mkdir -p /app/data && chown -R appuser:appgroup /app
COPY <二进制名> .
USER appuser
EXPOSE <端口>
ENV PORT=<端口>
CMD ["./<二进制名>"]
```

Node 前端（静态导出）：

```dockerfile
FROM caddy:alpine
COPY ./out /srv
COPY Caddyfile /etc/caddy/Caddyfile
```

### 3. 写 docker-compose.yml

后端：

```yaml
services:
  <服务名>:
    image: <服务名>
    container_name: <服务名>
    hostname: <服务名>
    restart: always
    environment:
      - TZ=Asia/Shanghai
      - SERVER_ENV=prod
    volumes:
      - ./logs:/app/logs
      - ./data:/app/data
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "<端口>:<端口>"
    logging:
      driver: json-file
      options: { max-size: "50m", max-file: "10", compress: "true" }
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:<端口>/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 15s
networks:
  default:
    external: true
    name: local
```

前端（静态）：

```yaml
services:
  <服务名>:
    image: <服务名>
    container_name: <服务名>
    hostname: <服务名>
    restart: always
    environment:
      - TZ=Asia/Shanghai
    networks:
      - local
networks:
  local:
    external: true
    name: local
```

### 4. 起服务

**走 `ops_deploy_apply`**，别自己去服务器上敲 —— 它会把 compose 和附带文件写到
`/opt/docker-apps/<服务名>/`，然后执行 `docker compose up -d --build`，把构建
输出的最后一段回给你。体检有 block 项时它会被拒绝，先解决再来。

它不接受任意命令，只认 compose 这一件事 —— 所以"帮我跑个脚本"这类需求要说清楚
（那是 `ops_automation_task_run` 的活，属于破坏性操作，要用户确认）。

只有在 ZOPS 本身不可用、且用户明确要求时，才考虑手动方式：

```sh
docker network create local 2>/dev/null || true   # 已存在会报错，忽略
cd /opt/docker-apps/<服务名>
docker compose up -d --build
docker compose ps
```

### 5. 验证，别只看 compose 说了什么

- `ops_container_logs`（tail 开到 100）看有没有报错退出
- `ops_container_list` 确认 state 是 running
- 起得来但功能不对，再 `ops_container_logs` 看具体报错
- 发布了端口就直接 `curl -fsS http://127.0.0.1:<端口>/health`

### 6. 接入网关

1. `ops_caddyfile_get` 先拿一份原文（要改之前必须有备份）
2. 按现有站点的格式加一段，反代到 `localhost:<端口>`（后端）或 `<容器名>:80`（前端）
3. **确认后**再 `ops_caddyfile_put` → `ops_gateway_reload`
4. 实际访问一次域名，别只看 reload 返回成功

### 7. 告诉人

`ops_notify_send`，`event` 用 `deploy`：

```
title: <服务名> 部署完成
text:  端口 <端口>，健康检查通过，已接入 <域名>
```

没配通知渠道时会返回 `sent: 0`，那就在对话里直接说结果。

## 六、几条别踩的

- **别把密钥写进 compose**：用同目录 `.env` 加 `${VAR}`，compose 只管路径和端口。
- **别动别人的容器**：这台机器上跑着好几个项目，`docker compose down` 只能在自己
  那个目录里执行。
- **磁盘先看**：镜像构建很吃盘，`ops_system_overview` 里磁盘 90% 以上先跟用户说。
- **端口报冲突**：`bind: address already in use` 就是端口被抢了，回第 1 步重挑一个，
  不要 kill 掉占用它的进程。
- **别为小事打断用户**：能按既有风格自己补的（restart / 日志轮转 / 时区 / 网络 /
  明文密钥改 `.env`）直接补，补完说一句就行。只有"会导致生产事故"和"用户才有
  决定权"的事才停下来问，而且要带上"可以忽略"这个选项。
