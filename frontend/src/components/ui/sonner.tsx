import {
  CircleCheck,
  Info,
  TriangleAlert,
  OctagonX,
  Loader2,
} from 'lucide-react';
import { Toaster as Sonner, toast } from 'sonner';
import { useThemeStore, resolveTheme } from '../../stores/theme-store';

export { toast };

/** App-wide toasts — aligned with yueqixing-oms-web (plain, not richColors). */
export function Toaster() {
  const theme = useThemeStore((s) => s.theme);
  const resolved = resolveTheme(theme);

  return (
    <Sonner
      theme={resolved}
      className="toaster group"
      position="top-center"
      duration={2800}
      icons={{
        success: <CircleCheck className="size-4" />,
        info: <Info className="size-4" />,
        warning: <TriangleAlert className="size-4" />,
        error: <OctagonX className="size-4" />,
        loading: <Loader2 className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
    />
  );
}
