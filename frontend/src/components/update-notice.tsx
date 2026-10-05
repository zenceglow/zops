import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
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
 * 前者是骗人，后者是噪音，所以"稍后"只压一天，而复制完命令就等于"我看到了"，
 * 这个版本不再提。
 */
export function UpdateNotice() {
  const { t } = useTranslation();
  const { status, show, skip, snooze } = useRelease();
  const [copied, setCopied] = useState(false);

  if (!show || !status?.latest) return null;

  /** 复制成功就先亮一下"已复制"，再收起来 —— 直接关掉的话用户不知道到底复上没有。 */
  const copyAndClose = async () => {
    const ok = await copyText(status.install_command);
    if (!ok) {
      toast.error(t('about.copy_failed'));
      return;
    }
    setCopied(true);
    setTimeout(skip, 700);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && snooze()}>
      {/* 短，所以窄：弹窗里就三行 —— 版本、说明、一行命令。 */}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('update.title', { version: status.latest })}</DialogTitle>
          <DialogDescription>{t('update.desc', { current: status.current })}</DialogDescription>
        </DialogHeader>

        {status.notes && (
          // 说明可能很长（那是提交标题），最多三行，别把弹窗撑开。
          <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{status.notes}</p>
        )}

        {/* 一行命令，长了就截断 —— 完整内容在 title 里，不靠换行把弹窗撑开。 */}
        <code
          className="block truncate rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 font-mono text-xs"
          title={status.install_command}
        >
          {status.install_command}
        </code>

        <DialogFooter>
          <Button variant="ghost" onClick={snooze}>
            {t('update.later')}
          </Button>
          <Button onClick={() => void copyAndClose()}>
            {copied ? <Check /> : <Copy />}
            {copied ? t('update.copied') : t('update.copy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
