const api = (path: string) => `/api/ops${path}`;

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(api('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('Login failed');
  const data = await res.json();
  return data.token as string;
}

async function apiGet<T>(path: string): Promise<T> {
  const token = localStorage.getItem('token');
  const res = await fetch(api(path), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return res.json() as Promise<T>;
}

async function apiPost(path: string, body?: unknown): Promise<any> {
  const token = localStorage.getItem('token');
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return res.json();
}

export { api, login, apiGet, apiPost };
