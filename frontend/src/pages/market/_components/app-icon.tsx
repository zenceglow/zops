import type { IconType } from 'react-icons';
import { SiMinio, SiMysql, SiPostgresql, SiRedis } from 'react-icons/si';
import { Package } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * 应用图标。
 *
 * 用品牌自己的图形和颜色，而不是按分类给一个通用图标：这四张卡片第一眼要能分辨出
 * 是哪个东西 —— 通用图标配文字也能看懂，但每次都要读一遍字。
 *
 * 颜色写死而不是跟随主题：品牌色是识别的一部分（MySQL 的蓝、Redis 的红），跟着
 * 主题变就不认了。底色用当前色 10% 的浅色块，深浅主题下都压得住。
 */
const BRAND: Record<string, { Icon: IconType; color: string }> = {
  mysql: { Icon: SiMysql, color: '#4479A1' },
  postgres: { Icon: SiPostgresql, color: '#4169E1' },
  redis: { Icon: SiRedis, color: '#DC382D' },
  minio: { Icon: SiMinio, color: '#C72C48' },
};

export function AppIcon({
  appId,
  className,
}: {
  appId: string;
  className?: string;
}) {
  const brand = BRAND[appId];

  if (!brand) {
    // 目录以后要换成用户上传的，认不出的 id 不该变成一块空白。
    return (
      <span
        className={cn(
          'flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground',
          className,
        )}
      >
        <Package className="size-5" />
      </span>
    );
  }

  const { Icon, color } = brand;
  return (
    <span
      className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', className)}
      style={{ backgroundColor: `${color}1a` }}
    >
      <Icon className="size-6" style={{ color }} />
    </span>
  );
}
