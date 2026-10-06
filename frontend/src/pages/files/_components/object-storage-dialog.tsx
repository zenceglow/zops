import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { toast } from '../../../components/ui/sonner';
import {
  createStore,
  deleteStore,
  listStores,
  uploadStore,
  type ObjectStore,
} from '../_api';

const PRESETS = {
  aws: { endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', path_style: false },
  oss: { endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'cn-hangzhou', path_style: true },
  r2: { endpoint: 'https://<accountid>.r2.cloudflarestorage.com', region: 'auto', path_style: true },
} as const;

type Provider = keyof typeof PRESETS;

export function ObjectStorageDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [stores, setStores] = useState<ObjectStore[]>([]);
  const [provider, setProvider] = useState<Provider>('r2');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState<string>(PRESETS.r2.endpoint);
  const [region, setRegion] = useState<string>(PRESETS.r2.region);
  const [bucket, setBucket] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secret, setSecret] = useState('');
  const [prefix, setPrefix] = useState('');
  const [pathStyle, setPathStyle] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => {
    void listStores()
      .then(setStores)
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const pick = (p: Provider) => {
    setProvider(p);
    setEndpoint(PRESETS[p].endpoint);
    setRegion(PRESETS[p].region);
    setPathStyle(PRESETS[p].path_style);
  };

  const save = async () => {
    setBusy(true);
    try {
      await createStore({
        name: name.trim(),
        provider,
        endpoint: endpoint.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
        access_key: accessKey.trim(),
        secret_key: secret.trim(),
        prefix: prefix.trim(),
        path_style: pathStyle,
      });
      setName('');
      setBucket('');
      setAccessKey('');
      setSecret('');
      toast.success(t('files.store_saved'));
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteStore(id);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('files.object_storage')}</DialogTitle>
          <DialogDescription>{t('files.object_storage_desc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {stores.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('files.store_empty')}</p>
          ) : (
            stores.map((s) => (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{s.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {s.provider} · {s.bucket} · {s.access_key_hint}
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove(s.id)}>
                  {t('files.delete')}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="grid gap-3">
          <div className="flex gap-2">
            {(['aws', 'oss', 'r2'] as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => pick(p)}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  provider === p ? 'border-foreground bg-foreground/10' : 'border-border text-muted-foreground'
                }`}
              >
                {t(`files.store_${p}`)}
              </button>
            ))}
          </div>
          <Field label={t('files.store_name')} value={name} onChange={setName} />
          <Field label="Endpoint" value={endpoint} onChange={setEndpoint} mono />
          <Field label="Region" value={region} onChange={setRegion} mono />
          <Field label="Bucket" value={bucket} onChange={setBucket} mono />
          <Field label="Access Key" value={accessKey} onChange={setAccessKey} mono />
          <Field label="Secret" value={secret} onChange={setSecret} mono secret />
          <Field label={t('files.store_prefix')} value={prefix} onChange={setPrefix} mono />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('sites.cancel')}
          </Button>
          <Button
            disabled={busy || !name.trim() || !bucket.trim() || !accessKey.trim() || !secret.trim()}
            onClick={() => void save()}
          >
            {busy && <Loader2 className="animate-spin" />}
            {t('settings.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UploadStoreDialog({
  open,
  path,
  onOpenChange,
  onNeedSetup,
}: {
  open: boolean;
  path: string;
  onOpenChange: (open: boolean) => void;
  onNeedSetup: () => void;
}) {
  const { t } = useTranslation();
  const [stores, setStores] = useState<ObjectStore[]>([]);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void listStores()
      .then((rows) => {
        setStores(rows);
        setId(rows[0]?.id ?? '');
        if (rows.length === 0) {
          onOpenChange(false);
          onNeedSetup();
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
    // 只在打开时拉一次。回调身份变了不该再请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const upload = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const res = await uploadStore(id, path);
      toast.success(t('files.upload_done', { key: res.key }));
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('files.upload_object')}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">{path}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {stores.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setId(s.id)}
              className={`block w-full rounded-xl border px-3 py-2 text-left text-sm ${
                id === s.id ? 'border-foreground' : 'border-border'
              }`}
            >
              {s.name}
              <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{s.bucket}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('sites.cancel')}
          </Button>
          <Button disabled={busy || !id} onClick={() => void upload()}>
            {busy && <Loader2 className="animate-spin" />}
            {t('files.upload_object')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  mono,
  secret,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
  secret?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? 'font-mono text-xs' : undefined}
      />
    </div>
  );
}
