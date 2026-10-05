# 部署剧本

用户说"把这个项目部署上去"时照这个走。目标只有一个：**别再手写 Dockerfile 和
compose** —— 这台机器上已经跑了二十来个服务，端口怎么分、网络怎么连、日志怎么
转、反代怎么写，全都有既定习惯，照着抄一遍就行。

## 一、先看现状，别拍脑袋

1. `ops_port_list` —— 谁占了哪些端口，还空着哪几个。**部署前必跑这一条**。
2. `ops_container_list` —— 已经跑着什么，命名和端口大致是什么风格。
3. `ops_caddyfile_get` —— 现有站点怎么写的。最新的那一段就是模板，别自创格式。
4. `ops_system_overview` —— 磁盘还够不够。不够就先说，别部署到一半失败。

## 二、这台机器的既有习惯

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

## 三、步骤

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

```sh
docker network create local 2>/dev/null || true   # 已存在会报错，忽略
cd /opt/docker-apps/<服务名>
docker compose up -d --build
docker compose ps
```

### 5. 验证，别只看 compose 说了什么

- `docker compose logs --tail=50` 看有没有报错退出
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

## 四、几条别踩的

- **别把密钥写进 compose**：用同目录 `.env` 加 `${VAR}`，compose 只管路径和端口。
- **别动别人的容器**：这台机器上跑着好几个项目，`docker compose down` 只能在自己
  那个目录里执行。
- **磁盘先看**：镜像构建很吃盘，`ops_system_overview` 里磁盘 90% 以上先跟用户说。
- **端口报冲突**：`bind: address already in use` 就是端口被抢了，回第 1 步重挑一个，
  不要 kill 掉占用它的进程。
