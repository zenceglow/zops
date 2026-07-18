import { Zap, Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { useLogin } from '../_hooks/use-login';

export function LoginForm() {
  const { t } = useTranslation();
  const {
    username,
    setUsername,
    password,
    setPassword,
    err,
    loading,
    showPw,
    setShowPw,
    submit,
  } = useLogin();

  return (
    <div className="w-full max-w-sm space-y-6">
      <div className="flex justify-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary shadow-sm">
          <Zap className="size-6 text-primary-foreground" />
        </div>
      </div>

      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">{t('app.name')}</CardTitle>
          <CardDescription>{t('login.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">{t('login.username')}</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t('login.username')}
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
                  className="pr-9"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-1 top-1/2 -translate-y-1/2"
                  onClick={() => setShowPw(!showPw)}
                  tabIndex={-1}
                >
                  {showPw ? <EyeOff /> : <Eye />}
                </Button>
              </div>
            </div>

            {err && <p className="text-sm text-destructive text-center">{err}</p>}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !username || !password}
            >
              {loading ? t('login.submitting') : t('login.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-xs text-center text-muted-foreground">
        Zenceglow Ops Panel v0.1.0
      </p>
    </div>
  );
}
