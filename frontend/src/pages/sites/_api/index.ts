import { del, get, post, put } from '../../../lib/api';
import type { GatewayConfig, GatewayLog, GatewayStatus } from './types';

export async function fetchGatewayStatus() {
  const res = await get<GatewayStatus>('/gateway/status');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchGatewayConfig() {
  const res = await get<GatewayConfig>('/gateway/file');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function fetchGatewayLogs(tail = 300) {
  const res = await get<GatewayLog>('/gateway/logs', { tail });
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function serverAction(action: 'start' | 'stop' | 'reload') {
  const res = await post(`/gateway/${action}`);
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function installGateway() {
  const res = await post('/gateway/install');
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function saveGatewayConfig(raw: string) {
  const res = await put('/gateway/file', { raw });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export interface CaddyfileVersion {
  id: number;
  author: string;
  note: string;
  created_at: string;
  size: number;
}

export async function fetchCaddyfileVersions() {
  const res = await get<CaddyfileVersion[]>('/gateway/versions');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function restoreCaddyfileVersion(id: number) {
  const res = await post(`/gateway/versions/${id}/restore`);
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function startContainer(id: string) {
  return post('/service/start', { id });
}

export async function stopContainer(id: string) {
  return post('/service/stop', { id });
}

export async function removeContainer(id: string) {
  return del('/service', { id });
}

export type { GatewayConfig, GatewayLog, GatewayStatus, Directive, SiteEntry } from './types';
