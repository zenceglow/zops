import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '../../../components/brand-logo';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useLogin } from '../_hooks/use-login';

export function LoginForm() {
  const { t } = useTranslation();
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
        ZOPS · v0.1.0
      </p>
    </div>
  );
}
