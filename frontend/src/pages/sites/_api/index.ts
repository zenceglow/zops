import { apiGet, apiPost } from '../../../lib/api';
import type { GatewayConfig, GatewayStatus } from './types';

const GW = '/api/ops/gateway';

export async function fetchGatewayStatus() {
  return apiGet<GatewayStatus>(`${GW}/server/status`);
}

export async function fetchGatewayConfig() {
  return apiGet<GatewayConfig>(`${GW}/file`);
}

export async function serverAction(action: string) {
  return apiPost(`${GW}/server/${action}`);
}

export async function installGateway() {
  return apiPost(`${GW}/server/install`);
}

export async function saveGatewayConfig(raw: string) {
  const token = localStorage.getItem('token');
  const res = await fetch(`${GW}/file`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText);
  }
}

export type { GatewayConfig, GatewayStatus, Directive, SiteEntry } from './types';
