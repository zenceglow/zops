import { get } from '../../../lib/api';

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
