import { del, get, post, put } from '../../../lib/api';

export type MemberInfo = {
  id: number;
  username: string;
  role: string;
  created_at: string;
  permissions: string[];
};

export type PermissionDef = {
  id: string;
  group: string;
};

export function listMembers() {
  return get<MemberInfo[]>('/member/list');
}

export function createMember(body: {
  username: string;
  password: string;
  permissions: string[];
}) {
  return post<MemberInfo>('/member/create', body);
}

export function updateMember(body: {
  id: number;
  password?: string;
  permissions?: string[];
}) {
  return put<MemberInfo>('/member', body);
}

export function deleteMember(id: number) {
  return del<unknown>('/member', { id });
}

export function listPermissions() {
  return get<PermissionDef[]>('/permission/list');
}
