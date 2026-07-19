import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import { Badge } from '../../../components/ui/badge';
import { Card, CardContent } from '../../../components/ui/card';
import { ROLE_SUPER_ADMIN } from '../../../lib/permissions';
import usePermissionCatalog from '../../../stores/permission.store';
import { useMembers } from '../_hooks/use-members';

function PermPicker({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: { id: string; group: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const nav = catalog.filter((p) => p.group === 'nav');
  const ops = catalog.filter((p) => p.group === 'ops');

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  const Section = ({ title, items }: { title: string; items: typeof catalog }) => (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-2">
        {items.map((p) => {
          const on = value.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(p.id)}
              className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted/50'
              } disabled:opacity-50`}
            >
              {t(`perm.${p.id}`, { defaultValue: p.id })}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Section title={t('members.perm_nav')} items={nav} />
      <Section title={t('members.perm_ops')} items={ops} />
    </div>
  );
}

export function MembersPanel() {
  const { t } = useTranslation();
  const m = useMembers();
  const catalog = usePermissionCatalog((s) => s.catalog);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [perms, setPerms] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [pwId, setPwId] = useState<number | null>(null);
  const [newPw, setNewPw] = useState('');

  const editing = useMemo(
    () => m.members.find((x) => x.id === editingId) ?? null,
    [m.members, editingId],
  );

  const onCreate = async () => {
    if (!username.trim() || password.length < 6) return;
    const ok = await m.add(username.trim(), password, perms);
    if (ok) {
      setUsername('');
      setPassword('');
      setPerms([]);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('members.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('members.subtitle')}</p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4 sm:p-5">
          <h2 className="text-sm font-semibold">{t('members.add')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="m-user">{t('members.username')}</Label>
              <Input
                id="m-user"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="m-pass">{t('members.password')}</Label>
              <Input
                id="m-pass"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <PermPicker catalog={catalog} value={perms} onChange={setPerms} />
          <Button
            className="h-9"
            disabled={!username.trim() || password.length < 6 || m.loading}
            onClick={() => void onCreate()}
          >
            {t('members.create')}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{t('members.list')}</h2>
        {m.loading && (
          <p className="text-sm text-muted-foreground">{t('app.loading')}</p>
        )}
        <div className="divide-y divide-border rounded-lg border border-border">
          {m.members.map((row) => (
            <div key={row.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{row.username}</span>
                  <Badge variant="secondary">
                    {row.role === ROLE_SUPER_ADMIN
                      ? t('members.role_super')
                      : t('members.role_member')}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {row.role === ROLE_SUPER_ADMIN
                    ? t('members.all_perms')
                    : row.permissions.length
                      ? row.permissions.join(', ')
                      : t('members.no_perms')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {row.role !== ROLE_SUPER_ADMIN && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => {
                      setEditingId(row.id);
                      setEditPerms([...row.permissions]);
                    }}
                  >
                    {t('members.edit_perms')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => {
                    setPwId(row.id);
                    setNewPw('');
                  }}
                >
                  {t('members.reset_pw')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-destructive"
                  onClick={() => void m.remove(row.id)}
                >
                  {t('members.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <h2 className="text-sm font-semibold">
              {t('members.edit_perms')} · {editing.username}
            </h2>
            <PermPicker catalog={catalog} value={editPerms} onChange={setEditPerms} />
            <div className="flex gap-2">
              <Button
                className="h-9"
                onClick={async () => {
                  const ok = await m.savePerms(editing.id, editPerms);
                  if (ok) setEditingId(null);
                }}
              >
                {t('members.save')}
              </Button>
              <Button variant="outline" className="h-9" onClick={() => setEditingId(null)}>
                {t('members.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {pwId != null && (
        <Card>
          <CardContent className="space-y-4 p-4 sm:p-5">
            <h2 className="text-sm font-semibold">{t('members.reset_pw')}</h2>
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="new-pw">{t('members.password')}</Label>
              <Input
                id="new-pw"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="flex gap-2">
              <Button
                className="h-9"
                disabled={newPw.length < 6}
                onClick={async () => {
                  const ok = await m.resetPassword(pwId, newPw);
                  if (ok) setPwId(null);
                }}
              >
                {t('members.save')}
              </Button>
              <Button variant="outline" className="h-9" onClick={() => setPwId(null)}>
                {t('members.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
