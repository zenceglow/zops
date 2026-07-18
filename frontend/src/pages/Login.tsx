import React, { useState } from 'react';
import { login } from '../main';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const token = await login(username, password);
      localStorage.setItem('token', token);
      window.location.href = '/dashboard';
    } catch {
      setErr('用户名或密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg dark:shadow-gray-950/60 border border-gray-200 dark:border-gray-800 p-8">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Zenceglow Ops</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">服务器运维面板</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                placeholder="用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700
                           bg-white dark:bg-gray-800
                           text-gray-900 dark:text-gray-100
                           placeholder-gray-400 dark:placeholder-gray-500
                           focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400
                           transition-colors"
              />
            </div>
            <div>
              <input
                type="password"
                placeholder="密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700
                           bg-white dark:bg-gray-800
                           text-gray-900 dark:text-gray-100
                           placeholder-gray-400 dark:placeholder-gray-500
                           focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400
                           transition-colors"
              />
            </div>

            {err && (
              <p className="text-sm text-red-600 dark:text-red-400 text-center">{err}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 rounded-lg font-medium text-white
                         bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                         disabled:opacity-50 disabled:cursor-not-allowed
                         transition-colors"
            >
              {loading ? '登录中…' : '登录'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
