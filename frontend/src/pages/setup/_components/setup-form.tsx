import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BrandLogo } from '../../../components/brand-logo';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useSetup } from '../_hooks/use-setup';

export function SetupForm() {
  const { t } = useTranslation();
  const {
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
  } = useSetup();

  return (
    <div className="w-full max-w-[360px]">
      <div className="mb-10 flex flex-col items-center text-center">
        <BrandLogo className="mb-3 text-[2.6rem] text-foreground" />
        <h1 className="text-[1.65rem] font-semibold tracking-tight text-foreground">
          {step === 1 ? t('setup.title_secret') : t('setup.title_admin')}
        </h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {step === 1 ? t('setup.desc_secret') : t('setup.desc_admin')}
        </p>
      </div>

      {step === 1 ? (
        <form onSubmit={goNext} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="secret">{t('setup.secret')}</Label>
            <Input
              id="secret"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('setup.secret_placeholder')}
              className="h-10"
            />
          </div>
          <Button type="submit" className="h-10 w-full font-medium">
            {t('setup.next')}
          </Button>
        </form>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="username">{t('setup.username')}</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('setup.password')}</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
          <div className="space-y-2">
            <Label htmlFor="confirm">{t('setup.confirm')}</Label>
            <Input
              id="confirm"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="h-10"
            />
          </div>
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="h-10 flex-1"
              onClick={() => setStep(1)}
              disabled={loading}
            >
              {t('setup.back')}
            </Button>
            <Button
              type="submit"
              className="h-10 flex-[1.4] font-medium"
              disabled={loading || !username || !password || !confirm}
            >
              {loading ? t('setup.submitting') : t('setup.submit')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
