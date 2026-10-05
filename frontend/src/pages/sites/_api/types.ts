export interface GatewayStatus {
  installed: boolean;
  running: boolean;
  /** 面板是怎么驱动 Caddy 的：容器 / 本机二进制 / 没装。 */
  runtime: 'docker' | 'binary' | 'none';
  container: string | null;
  version: string;
  pid: number | null;
  bin_path: string;
  /** 配置文件最后修改时间（Unix 毫秒）；文件不存在时为 null。 */
  config_modified: number | null;
  caddyfile_path: string;
}

export interface GatewayLog {
  /** 日志来源，直接展示给用户：`docker:caddy` / `journald (caddy.service)` / 文件路径。 */
  source: string;
  lines: string[];
  /** false 表示没找到日志，`hint` 里写了为什么、该怎么办。 */
  available: boolean;
  hint: string | null;
}

export interface Directive {
  key: string;
  args: string[];
  sub: Directive[];
}

export interface SiteEntry {
  addr: string;
  directives: Directive[];
}

export interface ParsedConfig {
  sites: SiteEntry[];
  preamble: string;
}

export interface GatewayConfig {
  raw: string;
  parsed: ParsedConfig;
}
