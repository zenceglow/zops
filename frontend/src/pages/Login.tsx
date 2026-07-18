import React, { useState } from 'react';
import { login } from '../main';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const token = await login(username, password);
      localStorage.setItem('token', token);
      window.location.href = '/dashboard';
    } catch {
      setErr('用户名或密码错误');
    }
  };

  return (
    <div style={{ maxWidth: 400, margin: '100px auto', padding: 24 }}>
      <h1>Zenceglow Ops</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <input
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 12 }}
          />
        </div>
        <div>
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: 8, marginBottom: 12 }}
          />
        </div>
        {err && <p style={{ color: 'red' }}>{err}</p>}
        <button type="submit" style={{ width: '100%', padding: 10 }}>
          登录
        </button>
      </form>
    </div>
  );
}
