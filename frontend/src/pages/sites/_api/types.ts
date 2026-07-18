export interface GatewayStatus {
  installed: boolean;
  running: boolean;
  version: string;
  pid: number | null;
  bin_path: string;
  caddyfile_path: string;
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
