export type SshConnectPayload = {
  type: 'connect';
  host: string;
  port: number;
  username: string;
  password: string;
  cols: number;
  rows: number;
};

export type SshClientMsg =
  | SshConnectPayload
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type SshServerMsg =
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string }
  | { type: 'closed' };

export function sshWsUrl(token: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return `${proto}//${host}/api/ops/ssh/ws?token=${encodeURIComponent(token)}`;
}
