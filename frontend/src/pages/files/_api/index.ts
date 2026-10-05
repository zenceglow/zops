import { get, post } from '../../../lib/api';

export type FileEntry = {
  name: string;
  path: string;
  /** dir | file | symlink | other */
  kind: string;
  size: number;
  modified: string;
  mode: string;
  /** 搜索时相对搜索根的位置。 */
  rel: string;
};

export type DirListing = {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
};

export type FilePreview = {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
};

const q = (s: string) => encodeURIComponent(s);

export async function listDir(path: string) {
  const res = await get<DirListing>(`/files/list?path=${q(path)}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function searchFiles(path: string, query: string) {
  const res = await get<FileEntry[]>(`/files/search?path=${q(path)}&q=${q(query)}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function previewFile(path: string) {
  const res = await get<FilePreview>(`/files/preview?path=${q(path)}`);
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

// ── 写操作 ──

export type TrashItem = {
  id: string;
  name: string;
  original_path: string;
  size: number;
  kind: string;
  deleted_at: string;
};

export async function movePaths(paths: string[], to: string) {
  const res = await post('/files/move', { paths, to });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function copyPaths(paths: string[], to: string) {
  const res = await post('/files/copy', { paths, to });
  if (!res.success) throw new Error(res.message || 'Failed');
}

/** 删除 = 进回收站。 */
export async function trashPaths(paths: string[]) {
  const res = await post('/files/trash', { paths });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function listTrash() {
  const res = await get<TrashItem[]>('/files/trash/list');
  if (!res.success || !res.data) throw new Error(res.message || 'Failed');
  return res.data;
}

export async function restoreTrash(ids: string[]) {
  const res = await post('/files/trash/restore', { ids });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function purgeTrash(ids: string[]) {
  const res = await post('/files/trash/purge', { ids });
  if (!res.success) throw new Error(res.message || 'Failed');
}

export async function emptyTrash() {
  const res = await post('/files/trash/empty', {});
  if (!res.success) throw new Error(res.message || 'Failed');
}
