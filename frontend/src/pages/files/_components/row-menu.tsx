import { Fragment } from 'react';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { cn } from '../../../lib/utils';

export interface RowAction {
  label: string;
  icon?: LucideIcon;
  variant?: 'default' | 'destructive';
  /** 在这个动作前画一条分割线，把"查看"和"改动"分开。 */
  separated?: boolean;
  onSelect: () => void;
}

/**
 * 列表行尾的「⋯」。
 *
 * 单个文件的操作放这儿，而不是常驻一整排按钮：一排按钮会让每一行都很吵，而且
 * 行与行之间看起来一模一样，用户也分不清点的是哪一行。批量操作走「选择」模式，
 * 这里只管这一行。
 */
export function RowMenu({ actions, label }: { actions: RowAction[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          // 不拦的话点击会冒泡到整行的"选中"，菜单一开一关行就被选上了。
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            'ml-1 shrink-0 rounded-lg p-1.5 text-muted-foreground/60 transition-colors',
            'hover:bg-muted hover:text-foreground',
            'data-[state=open]:bg-muted data-[state=open]:text-foreground',
          )}
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {actions.map((action, i) => (
          <Fragment key={action.label}>
            {action.separated && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem variant={action.variant} onSelect={action.onSelect}>
              {action.icon && <action.icon />}
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
