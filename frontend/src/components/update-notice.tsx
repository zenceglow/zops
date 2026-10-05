import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Download, Loader2 } from 'lucide-react';
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
import { get, post } from '../lib/api';
import { useRelease } from '../hooks/use-release';

/**
 * "有新版本"的弹窗。
 *
 * 只在**确实拉到清单、而且清单里的版本比当前新**的时候弹 —— 拿不到清单就什么都
 * 不做。更新提示最忌讳两种：把"没查到"说成"已是最新"，和每次刷新都弹一遍。
 * 前者是骗人，后者是噪音，所以"稍后"只压一天。
 *
 * 主按钮是**就地升级**而不是复制命令：让用户复制一行 curl 再自己贴到 SSH 里，
 * 多出来的这几步没有价值，还容易贴错。命令只在自动升级不适用（比如本地跑着的
 * 开发实例）或者升级失败时才露出来当退路。
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const { status, show, skip, snooze } = useRelease();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'applying' | 'restarting'>('idle');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  if (!show || !status?.latest) return null;

  const latest = status.latest;
  const working = busy !== 'idle';
  // 升级到一半不该被误关：点掉遮罩之后用户就不知道到底成没成。
  const dismissible = !working && !done;

  const copyCommand = async () => {
    if (await copyText(status.install_command)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error(t('about.copy_failed'));
    }
  };

  /** 升级：换完二进制服务会重启，所以先等它下去、再等它上来。 */
  const applyNow = async () => {
    setError('');
    setBusy('applying');
    const res = await post<{ version: string }>('/system/release/apply').catch(() => null);
    if (!res?.success) {
      setBusy('idle');
      setError(res?.message || t('update.apply_failed'));
      return;
    }

    setBusy('restarting');
    // 面板重启会有一两秒连不上，这段时间的失败是**预期**的，不当错误处理。
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const p = await get<{ version: string }>('/system/panel').catch(() => null);
      if (p?.success && p.data?.version === latest) {
        setDone(true);
        setBusy('idle');
        setTimeout(() => window.location.reload(), 1200);
        return;
      }
    }
    // 等超时了：多半是二进制已经换了、服务却没起来。让用户知道该去哪儿看。
    setBusy('idle');
    setError(t('update.restart_slow'));
  };

  const commandRow = (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs"
        title={status.install_command}
      >
        {status.install_command}
      </code>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void copyCommand()}>
        {copied ? <Check /> : <Copy />}
        {copied ? t('update.copied') : t('update.copy')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && dismissible) snooze();
      }}
    >
      {/* `[&>*]:min-w-0` 不能省：DialogContent 是个 grid，grid 子项默认
          `min-width: auto`，于是"一行命令不许换行"的 min-content 会把整块内容
          顶到弹窗外面去 —— 命令越长溢出越多，看着像弹窗没生效。放开子项的最小
          宽度，里面的 truncate 才有机会真的截断。 */}
      <DialogContent className="sm:max-w-md [&>*]:min-w-0" showCloseButton={dismissible}>
        <DialogHeader>
          <DialogTitle>{t('update.title', { version: latest })}</DialogTitle>
          {!done && (
            <DialogDescription>{t('update.desc', { current: status.current })}</DialogDescription>
          )}
        </DialogHeader>

        {done ? (
          <p className="flex items-center gap-2 text-sm">
            <Check className="size-4 text-emerald-500" />
            {t('update.done', { version: latest })}
          </p>
        ) : (
          <>
            {status.notes && (
              // 说明可能很长（那是提交标题），最多三行，别把弹窗撑开。
              <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
                {status.notes}
              </p>
            )}

            {working && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {busy === 'applying' ? t('update.downloading') : t('update.restarting')}
              </p>
            )}

            {error && (
              <div className="space-y-2">
                <p className="text-sm text-amber-600 dark:text-amber-400">{error}</p>
                {commandRow}
              </div>
            )}

            {!working && !error && !status.can_apply && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('update.manual_hint')}</p>
                {commandRow}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          {!done && (
            <Button variant="ghost" disabled={working} onClick={snooze}>
              {t('update.later')}
            </Button>
          )}
          {status.can_apply ? (
            <Button disabled={working || done} onClick={() => void applyNow()}>
              {working ? <Loader2 className="animate-spin" /> : <Download />}
              {busy === 'applying'
                ? t('update.downloading_short')
                : busy === 'restarting'
                  ? t('update.restarting_short')
                  : t('update.now')}
            </Button>
          ) : (
            <Button
              disabled={working}
              onClick={() => {
                void copyCommand();
                skip();
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? t('update.copied') : t('update.copy_now')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
