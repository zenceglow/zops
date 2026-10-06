"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "src/lib/utils"
import { Button } from "src/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // 10% 的黑在深色主题下等于没有：底本来就黑，叠一层更黑看不出来，于是对话框
        // 和页面糊在一起。给到 60/70 再加上毛玻璃，"底下还压着一层"才读得出来。
        "fixed inset-0 isolate z-[100] bg-black/60 duration-100 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 dark:bg-black/70",
        className
      )}
      {...props}
    />
  )
}

function isSlot(
  child: React.ReactNode,
  slot: typeof DialogHeader | typeof DialogFooter,
) {
  return React.isValidElement(child) && child.type === slot
}

/**
 * 标题和底栏钉在弹窗框上，只有中间滚动。
 *
 * 以前 overflow 写在整块 DialogContent 上，内容一长，关闭按钮和底部操作会跟着
 * 滚出屏幕。调用处不用改：直接子节点里的 Header / Footer 自动拆出去，其余进 body。
 */
function splitDialogChildren(children: React.ReactNode) {
  const header: React.ReactNode[] = []
  const footer: React.ReactNode[] = []
  const body: React.ReactNode[] = []
  React.Children.forEach(children, (child) => {
    if (isSlot(child, DialogHeader)) header.push(child)
    else if (isSlot(child, DialogFooter)) footer.push(child)
    else body.push(child)
  })
  return { header, footer, body }
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** Merged with default overlay styles (e.g. lightbox: `bg-black/90`). */
  overlayClassName?: string
}) {
  const handlePointerDownOutside = React.useCallback(
    (e: CustomEvent<{ originalEvent: PointerEvent }>) => {
      const target = (e.detail?.originalEvent?.target ?? e.target) as HTMLElement | null;
      // 防止点击 Select / Popover 弹层时误关闭 Dialog
      if (target?.closest('[data-slot="select-content"], [data-radix-popper-content-wrapper]')) {
        e.preventDefault();
        return;
      }
      onPointerDownOutside?.(e);
    },
    [onPointerDownOutside],
  );

  const { header, footer, body } = splitDialogChildren(children)

  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        onPointerDownOutside={handlePointerDownOutside}
        className={cn(
          // 框本身不滚。中间的 body 才滚，标题和按钮始终留在视口里。
          // overflow-x-hidden：只写 overflow-y 时，另一个轴会变成 auto，长路径会把
          // 整窗撑出横向滚动条。要横滚的表格和代码自己在内部滚。
          "fixed top-1/2 left-1/2 z-[100] flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[20px] bg-popover text-sm text-popover-foreground shadow-2xl shadow-black/40 ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {header.length > 0 && (
          <div className="shrink-0 px-4 pt-4 pr-12">{header}</div>
        )}
        <div
          data-slot="dialog-body"
          className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4"
        >
          {body}
        </div>
        {footer.length > 0 && (
          <div className="shrink-0 px-4 pb-4">{footer}</div>
        )}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // 不要独立底色、也不要那条分割线：那是"表单页脚"的写法，会把一个对话框
        // 切成上下两截。现在只是内容区最后一行按钮，靠间距分组就够了。
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
