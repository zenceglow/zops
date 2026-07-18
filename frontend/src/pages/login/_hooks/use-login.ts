import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { login } from '../_api';

export function useLogin() {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const token = await login(username, password);
      localStorage.setItem('token', token);
      window.location.href = '/monitor';
    } catch {
      setErr(t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  return {
    username,
    setUsername,
    password,
    setPassword,
    err,
    loading,
    showPw,
    setShowPw,
    submit,
  };
}
