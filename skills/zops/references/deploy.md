# 部署剧本

用户说"把这个项目部署上去"时照这个走。目标：**别再手写一遍 Docker 配置** ——
这台机器上跑了二十来个服务，端口怎么分、网络怎么连、日志怎么转、反代怎么写，
都有既定习惯，照着抄一遍就行。

## 〇、铁律：所有操作都经过 ZOPS

**不要 SSH 上去、不要在服务器上直接敲 docker、不要绕过面板改文件。**

走 ZOPS 的动作会进审计日志（谁在什么时候把什么改成什么样）。绕过面板做的改动，
出了问题没人查得到是从哪来的。工具不够用时，**停下来告诉用户缺什么**，不要自己
想办法绕过去。

## 一、部署任务通道（推荐路径）

部署 = **一个目录 + 产物 + 脚本 + 记录**。手动（用户在面板上点）和 agent 自动部署
走的是同一批记录：`deploy_jobs` / `deploy_runs`，谁在什么时候部署了什么、结果如何、
绑到哪个容器，事后都查得到。

### 先判断项目属于哪种

| 情况 | 怎么做 |
|---|---|
| 项目自带完善的 Dockerfile / compose | 直接用，只补这台机器的习惯（端口、网络、日志轮转、时区） |
| 没有 Docker 配置 | 照第四节写一份：Dockerfile + compose |
| 产物是发布包（tgz / dmg / 二进制） | 用第四节的脚本模板：解包 → 构建镜像 → 起服务 |

### agent 的六步

| 步骤 | 手段 |
|---|---|
| 1. 建任务（= 建 `/opt/docker-apps/<name>/`） | `ops_deploy_job_create` |
| 2. 传文本产物（compose / Dockerfile / 配置） | `ops_deploy_job_put_file` |
| 3. 传二进制产物（tgz / dmg） | HTTP 上传：<br>`curl -T package.tgz -H "Authorization: Bearer <令牌>" "<面板地址>/api/ops/deploy/job/upload?id=<name>&path=package.tgz"` |
| 4. 写部署脚本 | `ops_deploy_job_put_script` |
| 5. 执行（**先让用户确认**） | `ops_deploy_job_run` |
| 6. 拉进度 | `ops_deploy_job_log`（带上次的 `offset` 接着拉，`finished=true` 就是跑完） |

部署脚本在 `/opt/docker-apps/<name>/` 里以 `sh -c` 执行（开头等于已经 `set -e`）。
脚本要能重复跑：第二次部署是覆盖前一次的，不是从头来。

### 手动部署（用户自己在面板做）

面板「部署」页三步走 —— ① 建任务并上传产物 ② 编辑部署脚本 ③ 点执行，页面实时显示
日志。agent 要做的是把这三步准备到位，别替用户点执行。

## 二、先看现状，别拍脑袋

1. `ops_deploy_job_list` —— 这个服务是不是已经有部署任务了，别重复建。
2. `ops_port_list` —— 谁占了哪些端口，还空着哪几个。**部署前必跑这一条**。
3. `ops_container_list` / `ops_deploy_list` —— 已经跑着什么，命名和端口什么风格。
4. `ops_caddyfile_get` —— 现有站点怎么写的。最新的那一段就是模板，别自创格式。
5. `ops_system_overview` —— 磁盘够不够。不够先说，别部署到一半失败。

## 三、这台机器的既有习惯

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

## 四、参考模板

### Dockerfile：后端二进制

```dockerfile
FROM alpine:3.20
WORKDIR /app
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup \
    && mkdir -p /app/data && chown -R appuser:appgroup /app
COPY <二进制名> .
COPY configs ./configs
USER appuser
EXPOSE <端口>
ENV PORT=<端口>
CMD ["./<二进制名>"]
```

### Dockerfile：按需构建的 Go 服务

```dockerfile
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
RUN go build -o /out/app ./cmd/server

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/app ./app
COPY configs ./configs
EXPOSE <端口>
CMD ["./app", "-config", "configs/config.yaml"]
```

### Dockerfile：前端静态站

```dockerfile
FROM caddy:alpine
COPY ./dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
```

（`caddy:alpine` 的默认站点根是 `/srv`；SPA 需要 fallback 时在 Caddyfile 里写
`try_files {path} /index.html`。）

### docker-compose.yml：后端

```yaml
services:
  <服务名>:
    image: <服务名>
    build:
      context: .
      dockerfile: Dockerfile
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

### docker-compose.yml：前端静态

```yaml
services:
  <服务名>:
    image: <服务名>
    build:
      context: .
      dockerfile: Dockerfile
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

### 部署脚本模板（有发布包时）

在 `/opt/docker-apps/<服务名>/` 里执行，工作目录就是这个目录：

```sh
# 1. 解开产物
tar zxvf package.tgz -C ./

# 2. 摆成镜像要的样子（二进制直接摆在目录里 / 前端是 dist/）
rm -rf ./bin
mv -f ./<服务名>/* ./

# 3. 构建镜像并起服务。compose 会自己重建同名容器，不需要先 docker rm
docker build -t <服务名> .
docker compose up -d --build

# 4. 冒烟：有 /health 就探一下，别只看 compose 说了什么
curl -fsS http://127.0.0.1:<端口>/health
```

## 五、体检与验证

单个 compose 的体检还是走 `ops_deploy_plan`：端口撞车、缺 `restart` / 日志轮转 /
时区 / `local` 网络、明文凭据，一次报全。

**能自己解决的不要问用户**：`restart` / 日志轮转 / 时区 / 网络 / 明文密钥改 `.env`
这几项按第三节的风格补上就行，补完说一句。

跑完部署后：

1. `ops_deploy_job_log` 看到脚本退出码 0。
2. `ops_container_list` 确认新容器 state 是 running、名字对得上。
3. 起了但功能不对 → `ops_container_logs` 看具体报错。
4. 发布了端口就 `curl -fsS http://127.0.0.1:<端口>/health`。
5. 接网关：`ops_caddyfile_get` 先备份 → 加一段 → **确认后** `ops_caddyfile_put` →
   `ops_gateway_reload` → 实际访问一次域名。
6. `ops_notify_send`，`event` 用 `deploy`，说清端口、健康检查、域名。

## 六、几条别踩的

- **别把密钥写进 compose**：用同目录 `.env` 加 `${VAR}`，compose 只管路径和端口。
- **别动别人的容器**：这台机器上跑着好几个项目，`docker compose down` 只能在自己
  那个目录里执行。
- **别用 `docker rm -f` 再起**：`docker compose up -d` 会自己重建变更过的容器；
  先删容器反而会在重建失败时把服务留在地上。
- **磁盘先看**：镜像构建很吃盘，`ops_system_overview` 里磁盘 90% 以上先跟用户说。
- **端口报冲突**：`bind: address already in use` 就是端口被抢了，回第一步重挑一个，
  不要 kill 掉占用它的进程。
- **别为小事打断用户**：能按既有风格自己补的直接补；只有"会导致生产事故"和
  "用户才有决定权"的事才停下来问，并且要带上"可以忽略"这个选项。
