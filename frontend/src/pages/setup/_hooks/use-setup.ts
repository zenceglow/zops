import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from '../../../components/ui/sonner';
import { completeSetup } from '../_api';

export function useSetup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [secret, setSecret] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const goNext = (e: FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) {
      toast.error(t('setup.secret_required'));
      return;
    }
    setStep(2);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      toast.error(t('setup.password_short'));
      return;
    }
    if (password !== confirm) {
      toast.error(t('setup.password_mismatch'));
      return;
    }
    setLoading(true);
    try {
      const res = await completeSetup(secret.trim(), username.trim(), password);
      if (!res.success) {
        toast.error(res.message || t('setup.error'));
        return;
      }
      navigate('/login', { replace: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      toast.error(msg || t('setup.error'));
    } finally {
      setLoading(false);
    }
  };

  return {
    step,
    setStep,
    secret,
    setSecret,
    username,
    setUsername,
    password,
    setPassword,
    confirm,
    setConfirm,
    loading,
    showPw,
    setShowPw,
    goNext,
    submit,
  };
}
