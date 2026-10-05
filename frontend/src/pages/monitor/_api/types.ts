export interface SysInfo {
  hostname: string;
  os: string;
  cpu_usage: number;
  cpu_cores: number;
  memory_total: number;
  memory_used: number;
  memory_percent: number;
  swap_total: number;
  swap_used: number;
  uptime_secs: number;
  load_avg: number[];
  processes: number;
  kernel: string;
  disks: { mount: string; total: number; used: number; percent: number }[];
  network: { name: string; rx_bytes: number; tx_bytes: number }[];
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  /** 启动时刻（RFC3339）；从未启动过的容器为空串。 */
  started_at: string;
  /** 单核口径的 CPU 百分比（100% = 占满一个核）；停止的容器为 null。 */
  cpu_percent: number | null;
  /** 实际占用内存（已扣掉 page cache）与上限，单位字节。 */
  mem_used: number | null;
  mem_limit: number | null;
}

export interface DockerStatus {
  available: boolean;
  version: string;
}

export interface MonitorData {
  sys: SysInfo;
  containers: ContainerInfo[];
  docker: DockerStatus;
}
