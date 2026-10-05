import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Sparkles } from 'lucide-react';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { toast } from './ui/sonner';
import { copyText } from '../lib/clipboard';
import { useRelease } from '../hooks/use-release';

/**
 * "有新版本"的弹窗。
 *
 * 只在**确实拉到清单、而且清单里的版本比当前新**的时候弹 —— 拿不到清单就什么都
 * 不做。更新提示最忌讳两种：把"没查到"说成"已是最新"，和每次刷新都弹一遍。
 * 前者是骗人，后者是噪音，所以关掉之后记在本地，同一个版本只提醒一次。
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const { status, show, skip } = useRelease();
  const [copied, setCopied] = useState(false);

  // 关掉这个版本之后别再自动弹回来；换了新版本会自动重新出现。
  useEffect(() => {
    setCopied(false);
  }, [show]);

  if (!show || !status?.latest) return null;

  const copyCommand = async () => {
    if (await copyText(status.install_command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('about.copy_failed'));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && skip()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-sky-500" />
            {t('update.title', { version: status.latest })}
          </DialogTitle>
          <DialogDescription>
            {t('update.desc', { current: status.current, latest: status.latest })}
          </DialogDescription>
        </DialogHeader>

        {status.notes && (
          <div className="rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 text-sm leading-6">
            {status.notes}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('update.howto')}</p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/30 py-2.5 pr-20 pl-3 font-mono text-xs">
              {status.install_command}
            </pre>
            <Button variant="secondary" size="sm" className="absolute right-2 bottom-2" onClick={copyCommand}>
              {copied ? <Check /> : <Copy />}
              {copied ? t('update.copied') : t('update.copy')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('update.safe')}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={skip}>
            {t('update.skip')}
          </Button>
          <Button variant="outline" onClick={() => window.open('https://github.com/zenceglow/zops/releases', '_blank')}>
            {t('update.releases')}
          </Button>
          <Button
            onClick={() => {
              void copyCommand();
              skip();
            }}
          >
            {t('update.got_it')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
