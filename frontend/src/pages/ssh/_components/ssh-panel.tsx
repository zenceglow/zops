import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { useSshTerminal } from '../_hooks/use-ssh-terminal';

export function SshPanel() {
  const { t } = useTranslation();
  const {
    containerRef,
    form,
    setForm,
    connected,
    connecting,
    status,
    connect,
    disconnect,
  } = useSshTerminal();

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('ssh.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('ssh.subtitle')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="ssh-host">{t('ssh.host')}</Label>
          <Input
            id="ssh-host"
            className="h-9 w-44"
            value={form.host}
            disabled={connected || connecting}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder="192.168.1.1"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ssh-port">{t('ssh.port')}</Label>
          <Input
            id="ssh-port"
            type="number"
            className="h-9 w-20"
            value={form.port}
            disabled={connected || connecting}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 22 })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ssh-user">{t('ssh.username')}</Label>
          <Input
            id="ssh-user"
            className="h-9 w-32"
            value={form.username}
            disabled={connected || connecting}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ssh-pass">{t('ssh.password')}</Label>
          <Input
            id="ssh-pass"
            type="password"
            className="h-9 w-40"
            value={form.password}
            disabled={connected || connecting}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !connected && !connecting) connect();
            }}
          />
        </div>
        {connected ? (
          <Button variant="outline" className="h-9" onClick={disconnect}>
            {t('ssh.disconnect')}
          </Button>
        ) : (
          <Button className="h-9" disabled={connecting} onClick={connect}>
            {connecting ? t('ssh.connecting') : t('ssh.connect')}
          </Button>
        )}
        {status && (
          <span className="pb-2 text-xs text-muted-foreground">{status}</span>
        )}
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-[#0c0c0c] p-2"
      />
    </div>
  );
}
