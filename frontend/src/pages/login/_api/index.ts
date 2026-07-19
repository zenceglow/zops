import { get, post } from '../../../lib/api';

export type LoginData = {
  access_token: string;
  username: string;
  role: string;
  permissions: string[];
};

export type MeData = {
  id: number;
  username: string;
  role: string;
  permissions: string[];
};

export function loginApi(username: string, password: string) {
  return post<LoginData>('/auth/login', { username, password });
}

export function fetchMe() {
  return get<MeData>('/auth/me');
}
