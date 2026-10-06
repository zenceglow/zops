import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '../../../components/brand-logo';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useLogin } from '../_hooks/use-login';

export function LoginForm() {
  const { t } = useTranslation();
  // 登录页也报一下版本 —— 排障第一件事就是确认"你看的是哪个版本的面板"。
  // 写死过一次 v0.1.0，之后每个版本都跟着错，所以从没鉴权的 /api/ops/version 读。
  const [version, setVersion] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/api/ops/version')
      .then((r) => r.json())
      .then((d: { data?: { version?: string } }) => {
        if (alive && d?.data?.version) setVersion(d.data.version);
      })
      .catch(() => {
        /* 拿不到版本就不显示，别让登录页因为一行小字报错 */
      });
    return () => {
      alive = false;
    };
  }, []);
  const {
    username,
    setUsername,
    password,
    setPassword,
    loading,
    showPw,
    setShowPw,
    submit,
  } = useLogin();

  return (
    <div className="w-full max-w-[360px]">
      <div className="mb-10 flex flex-col items-center text-center">
        <BrandLogo className="mb-5 size-12" />
        <h1 className="text-[1.65rem] font-semibold tracking-tight text-foreground">
          {t('app.name')}
        </h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {t('login.subtitle')}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="username">{t('login.username')}</Label>
          <Input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('login.username')}
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('login.password')}</Label>
          <div className="relative">
            <Input
              id="password"
              type={showPw ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('login.password')}
              className="h-10 pr-9"
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground"
              onClick={() => setShowPw(!showPw)}
              tabIndex={-1}
              aria-label={showPw ? 'Hide password' : 'Show password'}
            >
              {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        <Button
          type="submit"
          className="h-10 w-full font-medium"
          disabled={loading || !username || !password}
        >
          {loading ? t('login.submitting') : t('login.submit')}
        </Button>
      </form>

      <p className="mt-10 text-center text-xs text-muted-foreground/80">
        ZOPS{version ? ` · v${version}` : ''}
      </p>
    </div>
  );
}
