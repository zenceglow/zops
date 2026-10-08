//! 应用市场的目录：一个应用长什么样、装它要问用户什么。
//!
//! **为什么是"清单"而不是"一堆写死的 compose"**：目标是以后把这份清单搬到
//! ops.zenceglow.com 上，让用户上传自己编好的应用。所以这里描述的是**能力**——
//! 用哪个镜像、要发布哪些端口、要问哪些环境变量、数据落在哪、怎么探活——而
//! 不是一段完整 YAML。真正的 compose 由渲染器（`service::app_market`）按这台
//! 机器的既有习惯统一生成：网络 `local`、`restart: always`、`TZ`、日志轮转。
//! 换成本地清单还是远端清单，只影响 `catalog()` 的数据来源，渲染与安装一行不用改。
//!
//! 本轮是**内置**：`builtin()` 里硬编码，随二进制发布，不联网。

use serde::Serialize;

/// 一个要发布到宿主机的端口。
///
/// 只允许改**宿主**那一侧：容器端口是镜像的契约（MySQL 就是 3306），改了容器里
/// 的服务根本不会去听。所以表单里能改的是映射左边，右边固定。
#[derive(Debug, Clone, Serialize)]
pub struct AppPort {
    /// 稳定标识，前端用来回传用户填的值。同一个应用内唯一。
    pub key: &'static str,
    pub label: &'static str,
    pub label_en: &'static str,
    pub container: u16,
    pub host_default: u16,
    pub hint: &'static str,
    pub hint_en: &'static str,
}

/// 一个要问用户的环境变量。
#[derive(Debug, Clone, Serialize)]
pub struct AppEnv {
    pub key: &'static str,
    pub label: &'static str,
    pub label_en: &'static str,
    /// 预填值。空串 = 默认留空。
    pub default: &'static str,
    /// 密码类：前端用密码框，回显要遮。
    pub secret: bool,
    /// 必填。留空就拒绝安装 —— 密码留空装出来的库等于敞着门。
    pub required: bool,
    /// 最短长度，0 表示不限。存在的理由很具体：MinIO 少于 8 位**直接退出**，
    /// 不拦的话用户会得到一次"一键部署成功、容器三秒后死掉"，比报错难查得多。
    pub min_len: usize,
    pub hint: &'static str,
    pub hint_en: &'static str,
}

/// 一个数据卷。宿主侧一律是部署目录下的相对路径，不写绝对路径 ——
/// 绝对路径等于让用户把数据散落到文件系统各处，卸载时谁也说不清哪些能删。
#[derive(Debug, Clone, Serialize)]
pub struct AppVolume {
    pub host: &'static str,
    pub container: &'static str,
    pub label: &'static str,
    pub label_en: &'static str,
}

/// 一个内置应用。
#[derive(Debug, Clone, Serialize)]
pub struct AppSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// 一句话说清它是干什么的，卡片上就这一行。
    pub tagline: &'static str,
    pub tagline_en: &'static str,
    /// database | cache | storage。前端按它分组。
    pub category: &'static str,
    pub image: &'static str,
    pub version: &'static str,
    pub homepage: &'static str,
    pub docs: &'static str,
    pub license: &'static str,
    /// 默认应用名，同时是 `/opt/docker-apps/<name>/` 目录名和容器名。
    pub default_name: &'static str,
    pub ports: Vec<AppPort>,
    pub env: Vec<AppEnv>,
    /// 应用必须带的环境变量，不进表单、用户改不了。
    ///
    /// 和 `env` 分开是有意的：`env` 是"要问用户什么"，这里是"镜像的契约"。
    /// 比如 PostgreSQL 的 `PGDATA` 必须指向挂载点下的子目录（官方要求挂载点
    /// 要么是空目录、要么本身就是 PGDATA），把它放进表单只是给用户一个把库
    /// 装坏的机会。
    #[serde(skip_serializing)]
    pub fixed_env: Vec<(&'static str, &'static str)>,
    pub volumes: Vec<AppVolume>,
    /// compose 的 `command`，**列表形式**。
    ///
    /// 列表而不是字符串是有原因的：字符串形式要靠 compose 自己做一遍 shell 式词法
    /// 切分来决定参数边界，带引号、带空格时行为不好预期（MinIO 的
    /// `--console-address ":9001"`、Redis 的 `sh -c '...'` 都踩这条）。列表形式
    /// 参数边界由我们给死，compose 不做任何猜测。
    ///
    /// 里面的 `$$VAR` 是有意的：compose 先把 `$$` 还原成 `$`（**不展开**），再由
    /// 容器里的 sh 从环境变量展开。所以命令本身写的是变量名，密码值只在
    /// `environment` 里出现一次 —— 而 `command` 是会被 `docker ps` 打出来的那一列。
    pub command: Option<Vec<&'static str>>,
    /// compose `healthcheck.test` 的 CMD-SHELL 内容。同样用 `$$VAR`。
    pub healthcheck: Option<&'static str>,
    /// 装完之后告诉用户的话：怎么连、要不要改什么。
    pub notes: Vec<&'static str>,
    pub notes_en: Vec<&'static str>,
}

/// 内置目录。**这是本轮唯一的数据来源**，以后换成远端拉取时只替换这个函数。
pub fn builtin() -> Vec<AppSpec> {
    vec![mysql(), postgres(), redis(), minio()]
}

pub fn find(id: &str) -> Option<AppSpec> {
    builtin().into_iter().find(|a| a.id == id)
}

fn mysql() -> AppSpec {
    AppSpec {
        id: "mysql",
        name: "MySQL",
        tagline: "关系型数据库。字符集与排序规则按 zenceglow 既有习惯预设为 utf8mb4。",
        tagline_en: "Relational database, preconfigured with the utf8mb4 charset used across zenceglow.",
        category: "database",
        image: "mysql:8.4",
        version: "8.4",
        homepage: "https://www.mysql.com",
        docs: "https://dev.mysql.com/doc/refman/8.4/en/",
        license: "GPL-2.0",
        default_name: "mysql",
        ports: vec![AppPort {
            key: "mysql",
            label: "数据库端口",
            label_en: "Database port",
            container: 3306,
            host_default: 3306,
            hint: "客户端、应用连这个端口。同一个宿主上只能有一个服务占它。",
            hint_en: "Clients and apps connect here. Only one service can hold it per host.",
        }],
        env: vec![
            AppEnv {
                key: "MYSQL_ROOT_PASSWORD",
                label: "root 密码",
                label_en: "root password",
                default: "",
                secret: true,
                required: true,
                min_len: 1,
                hint: "必填。镜像不允许空密码启动，装完连库就用它。",
                hint_en: "Required — the image refuses to start with an empty password.",
            },
            AppEnv {
                key: "MYSQL_DATABASE",
                label: "初始库名",
                label_en: "Initial database",
                default: "app",
                secret: false,
                required: false,
                min_len: 0,
                hint: "装完自动建这个库；留空则只建系统库。",
                hint_en: "Created on first boot. Leave empty to create only the system schemas.",
            },
            AppEnv {
                key: "MYSQL_USER",
                label: "业务账号",
                label_en: "Application user",
                default: "",
                secret: false,
                required: false,
                min_len: 0,
                hint: "给应用用的账号（不给 root）。填了它，下面的密码也要填。",
                hint_en: "A non-root account for your app. If set, the password below is required too.",
            },
            AppEnv {
                key: "MYSQL_PASSWORD",
                label: "业务账号密码",
                label_en: "Application user password",
                default: "",
                secret: true,
                required: false,
                min_len: 1,
                hint: "配合上面的业务账号使用。",
                hint_en: "Used together with the application user above.",
            },
        ],
        volumes: vec![
            AppVolume {
                host: "./data",
                container: "/var/lib/mysql",
                label: "数据目录",
                label_en: "Data directory",
            },
            AppVolume {
                host: "./conf.d",
                container: "/etc/mysql/conf.d",
                label: "附加配置",
                label_en: "Extra config",
            },
        ],
        // 排序规则显式给 utf8mb4_0900_ai_ci（MySQL 8 的默认值）：这台机器上
        // zenceglow_db 有 38 张表是 utf8mb4_unicode_ci、7 张是 0900_ai_ci，
        // 跨表 JOIN 时会报 1267 Illegal mix of collations。新库统一到 0900_ai_ci，
        // 别再把混用带进来。
        fixed_env: vec![],
        command: Some(vec![
            "--character-set-server=utf8mb4",
            "--collation-server=utf8mb4_0900_ai_ci",
        ]),
        healthcheck: Some("mysqladmin ping -h 127.0.0.1 -uroot -p$$MYSQL_ROOT_PASSWORD --silent"),
        notes: vec![
            "首次启动要初始化数据目录，通常 20-60 秒；这期间探活是 unhealthy，属正常。",
            "连库：mysql -h 127.0.0.1 -P <端口> -u root -p",
            "容器名就是应用名，同网络下的其它容器直接用这个名字连它。",
        ],
        notes_en: vec![
            "First boot initialises the data directory — expect 20-60s of unhealthy.",
            "Connect with: mysql -h 127.0.0.1 -P <port> -u root -p",
            "The container name equals the app name; other containers on the same network reach it by that name.",
        ],
    }
}

fn postgres() -> AppSpec {
    AppSpec {
        id: "postgres",
        name: "PostgreSQL",
        tagline: "关系型数据库。装完可直接用，数据目录已按官方镜像要求指到子目录。",
        tagline_en: "Relational database, ready to use — the data directory is pointed at the subdirectory the official image requires.",
        category: "database",
        image: "postgres:17-alpine",
        version: "17",
        homepage: "https://www.postgresql.org",
        docs: "https://www.postgresql.org/docs/17/",
        license: "PostgreSQL",
        default_name: "postgres",
        ports: vec![AppPort {
            key: "postgres",
            label: "数据库端口",
            label_en: "Database port",
            container: 5432,
            host_default: 5432,
            hint: "客户端、应用连这个端口。",
            hint_en: "Clients and apps connect here.",
        }],
        env: vec![
            AppEnv {
                key: "POSTGRES_PASSWORD",
                label: "超级用户密码",
                label_en: "Superuser password",
                default: "",
                secret: true,
                required: true,
                min_len: 1,
                hint: "必填。镜像不允许空密码启动。",
                hint_en: "Required — the image refuses to start with an empty password.",
            },
            AppEnv {
                key: "POSTGRES_USER",
                label: "超级用户名",
                label_en: "Superuser name",
                default: "postgres",
                secret: false,
                required: false,
                min_len: 0,
                hint: "改了它，下面连库的命令也要跟着改。",
                hint_en: "If you rename it, adjust the connection command accordingly.",
            },
            AppEnv {
                key: "POSTGRES_DB",
                label: "初始库名",
                label_en: "Initial database",
                default: "app",
                secret: false,
                required: false,
                min_len: 0,
                hint: "装完自动建这个库。",
                hint_en: "Created on first boot.",
            },
        ],
        volumes: vec![AppVolume {
            host: "./data",
            container: "/var/lib/postgresql/data",
            label: "数据目录",
            label_en: "Data directory",
        }],
        // PGDATA 指到子目录：官方镜像要求挂载点要么是空目录、要么本身是 PGDATA。
        // 指一层子目录是官方推荐做法，也免得把 lost+found 当成数据目录。
        fixed_env: vec![("PGDATA", "/var/lib/postgresql/data/pgdata")],
        command: None,
        healthcheck: Some("pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"),
        notes: vec![
            "连库：psql -h 127.0.0.1 -p <端口> -U <用户名> -d <库名>",
            "容器名就是应用名，同网络下的其它容器直接用这个名字连它。",
        ],
        notes_en: vec![
            "Connect with: psql -h 127.0.0.1 -p <port> -U <user> -d <database>",
            "The container name equals the app name; other containers on the same network reach it by that name.",
        ],
    }
}

fn redis() -> AppSpec {
    AppSpec {
        id: "redis",
        name: "Redis",
        tagline: "内存缓存与队列。开启 AOF 持久化，重启不丢数据。",
        tagline_en: "In-memory cache and queue with AOF persistence enabled.",
        category: "cache",
        image: "redis:7-alpine",
        version: "7",
        homepage: "https://redis.io",
        docs: "https://redis.io/docs/latest/",
        license: "RSALv2 / SSPLv1",
        default_name: "redis",
        ports: vec![AppPort {
            key: "redis",
            label: "服务端口",
            label_en: "Service port",
            container: 6379,
            host_default: 6379,
            hint: "客户端连这个端口。",
            hint_en: "Clients connect here.",
        }],
        env: vec![
            // 密码设成**必填**是刻意的：它发布的是宿主端口，空密码就是把库敞着。
            // 本机前面虽然有网关，但 6379 一旦被别的规则放出去就是裸奔。
            AppEnv {
                key: "REDIS_PASSWORD",
                label: "访问密码",
                label_en: "Access password",
                default: "",
                secret: true,
                required: true,
                min_len: 1,
                hint: "必填。它发布的是宿主端口，不设密码等于把这个库敞开。",
                hint_en: "Required — this publishes a host port, so no password means an open database.",
            },
        ],
        volumes: vec![AppVolume {
            host: "./data",
            container: "/data",
            label: "数据目录（AOF）",
            label_en: "Data directory (AOF)",
        }],
        fixed_env: vec![],
        // redis-server 的 `--requirepass` 只能从命令行或配置文件给。命令行走
        // `sh -c`：compose 把 `$$` 还原成 `$` 之后，由 sh 从容器环境变量里取真值，
        // 于是 `docker ps` 的 COMMAND 列看到的还是变量名。
        command: Some(vec![
            "sh",
            "-c",
            "exec redis-server --appendonly yes --requirepass \"$$REDIS_PASSWORD\"",
        ]),
        healthcheck: Some("redis-cli -a $$REDIS_PASSWORD ping"),
        notes: vec![
            "连库：redis-cli -h 127.0.0.1 -p <端口> -a <密码>",
            "AOF 落在 ./data，容器重建数据还在。",
        ],
        notes_en: vec![
            "Connect with: redis-cli -h 127.0.0.1 -p <port> -a <password>",
            "The AOF lives in ./data, so a container rebuild keeps your data.",
        ],
    }
}

fn minio() -> AppSpec {
    AppSpec {
        id: "minio",
        name: "MinIO",
        tagline: "S3 兼容对象存储，带一个网页控制台。面板的文件页可以直接拿它当后端。",
        tagline_en: "S3-compatible object storage with a web console — the panel's file page can use it as a backend.",
        category: "storage",
        image: "minio/minio:latest",
        version: "latest",
        homepage: "https://min.io",
        docs: "https://min.io/docs/minio/container/index.html",
        license: "AGPL-3.0",
        default_name: "minio",
        ports: vec![
            AppPort {
                key: "api",
                label: "S3 接口端口",
                label_en: "S3 API port",
                container: 9000,
                host_default: 9000,
                hint: "SDK / mc / 面板的文件页都连这个。",
                hint_en: "SDKs, mc and the panel's file page all talk to this one.",
            },
            AppPort {
                key: "console",
                label: "控制台端口",
                label_en: "Console port",
                container: 9001,
                host_default: 9001,
                hint: "浏览器打开的网页控制台，只用来管桶和密钥。",
                hint_en: "The web console, for managing buckets and keys only.",
            },
        ],
        env: vec![
            AppEnv {
                key: "MINIO_ROOT_USER",
                label: "管理员账号",
                label_en: "Root user",
                default: "zops",
                secret: false,
                required: true,
                min_len: 0,
                hint: "控制台与 API 的登录名。",
                hint_en: "Login for both the console and the API.",
            },
            AppEnv {
                key: "MINIO_ROOT_PASSWORD",
                label: "管理员密码",
                label_en: "Root password",
                default: "",
                secret: true,
                required: true,
                min_len: 8,
                hint: "至少 8 位（MinIO 自己的限制），否则容器会直接退出。",
                hint_en: "At least 8 characters — MinIO refuses to start otherwise.",
            },
        ],
        volumes: vec![AppVolume {
            host: "./data",
            container: "/data",
            label: "对象数据目录",
            label_en: "Object data directory",
        }],
        fixed_env: vec![],
        command: Some(vec!["server", "/data", "--console-address", ":9001"]),
        // 刻意不给探活：MinIO 官方镜像里没有稳定的探活命令（curl 不一定装、mc 的
        // 位置随版本变），写一条恒报 unhealthy 的比不写更糟 —— 用户会以为装坏了。
        healthcheck: None,
        notes: vec![
            "控制台：http://<主机>:<控制台端口>",
            "镜像 tag 用的是 latest：MinIO 只发时间戳式 tag（RELEASE.…），没有可钉的主版本号。要固定版本就手动把 compose 里的 tag 改具体。",
        ],
        notes_en: vec![
            "Console: http://<host>:<console port>",
            "The image tag is latest — MinIO only ships timestamped tags (RELEASE.…), so there is no major version to pin. Edit the compose if you need a fixed one.",
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_ids_are_unique_and_findable() {
        let apps = builtin();
        let mut ids: Vec<&str> = apps.iter().map(|a| a.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "应用 id 不能重复");

        for id in ["mysql", "postgres", "redis", "minio"] {
            assert!(find(id).is_some(), "{id} 应该在目录里");
        }
        assert!(find("nope").is_none());
    }

    /// 端口 key 是前端回传用户填值时的键，重复就会把两个端口写成同一个值。
    #[test]
    fn port_keys_and_env_keys_are_unique_per_app() {
        for app in builtin() {
            let mut keys: Vec<&str> = app.ports.iter().map(|p| p.key).collect();
            let n = keys.len();
            keys.sort_unstable();
            keys.dedup();
            assert_eq!(keys.len(), n, "{} 的端口 key 重复了", app.id);

            let mut envs: Vec<&str> = app.env.iter().map(|e| e.key).collect();
            let n = envs.len();
            envs.sort_unstable();
            envs.dedup();
            assert_eq!(envs.len(), n, "{} 的环境变量 key 重复了", app.id);

            assert!(!app.ports.is_empty(), "{} 没有端口", app.id);
            assert!(!app.default_name.is_empty(), "{} 没有默认名", app.id);
        }
    }

    /// 表单的默认值是"一路回车也能装出个能用的东西"的前提，别留空。
    /// 密码类可以留空但必须标 required（由用户填），其余字段要有默认值。
    #[test]
    fn required_secrets_have_no_default_and_others_do() {
        for app in builtin() {
            for e in &app.env {
                if e.required && e.secret {
                    assert!(
                        e.default.is_empty(),
                        "{}.{} 是必填密码，不该有默认值",
                        app.id,
                        e.key
                    );
                }
                assert!(!e.label.is_empty() && !e.label_en.is_empty());
            }
            assert!(!app.notes.is_empty() && app.notes.len() == app.notes_en.len());
        }
    }
}
