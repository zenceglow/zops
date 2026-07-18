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
