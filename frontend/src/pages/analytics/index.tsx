import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Globe2, Loader2, RefreshCw, ShieldAlert, Bot, FileText } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { toast } from '../../components/ui/sonner';
import { cn } from '../../lib/utils';
import {
  fetchAnalytics,
  fetchRecentAccess,
  fetchSecurityEvents,
  type AccessEvent,
  type AnalyticsOverview,
  type SecurityEvent,
} from './_api';

/** 跟 yueqixing-oms-web 同一套底图（Carto 暗色），配色统一。 */
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const RANGES = [
  { hours: 1, labelKey: 'analytics.range_1h' },
  { hours: 24, labelKey: 'analytics.range_24h' },
  { hours: 24 * 7, labelKey: 'analytics.range_7d' },
] as const;

type Tab = 'access' | 'attack' | 'bot';

const TABS: { id: Tab; labelKey: string; icon: typeof FileText }[] = [
  { id: 'access', labelKey: 'analytics.tab_access', icon: FileText },
  { id: 'attack', labelKey: 'analytics.tab_attack', icon: ShieldAlert },
  { id: 'bot', labelKey: 'analytics.tab_bot', icon: Bot },
];

function pct(part: number, all: number) {
  if (!all) return '0%';
  return `${((part / all) * 100).toFixed(part / all >= 0.1 ? 1 : 2)}%`;
}

/** 每分钟是算出来的浮点（total / (hours*60)），直接渲染就是 8.17013888888889。 */
function perMinute(v: number | undefined) {
  return (v ?? 0).toFixed(1);
}

/**
 * 站点（域名）访问比例 —— 环形图。
 *
 * 自己画 SVG，不引图表库：这里只有"几个域名 + 一个其他"，为它装 echarts 是给打包
 * 体积加两百多 KB 去干二十行能画完的事。环形而不是实心饼：中间那块正好写总数。
 */
function SiteDonut({ data }: { data: { key: string; count: number }[] }) {
  const { t } = useTranslation();
  const palette = ['#34d399', '#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#fb7185', '#94a3b8'];
  // 超过 6 个的合成"其他"，图例才不会被一堆小域名塞满。
  const top = data.slice(0, 6);
  const restCount = data.slice(6).reduce((s, d) => s + d.count, 0);
  const slices = restCount > 0 ? [...top, { key: t('analytics.other_sites'), count: restCount }] : top;
  const sum = slices.reduce((s, d) => s + d.count, 0);
  if (sum === 0) return <p className="py-8 text-center text-xs text-muted-foreground">—</p>;

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let acc = 0;

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <svg viewBox="0 0 140 140" className="size-32 shrink-0">
        <g transform="rotate(-90 70 70)">
          <circle cx="70" cy="70" r={radius} fill="none" stroke="currentColor" strokeWidth="14" className="text-muted/50" />
          {slices.map((s, i) => {
            const len = (s.count / sum) * circumference;
            const dash = `${len} ${circumference - len}`;
            const offset = -acc;
            acc += len;
            return (
              <circle
                key={s.key}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={palette[i % palette.length]}
                strokeWidth="14"
                strokeDasharray={dash}
                strokeDashoffset={offset}
              />
            );
          })}
        </g>
        <text x="70" y="70" textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[15px] font-semibold">
          {sum}
        </text>
      </svg>
      <ul className="w-full min-w-0 space-y-1.5">
        {slices.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 text-xs">
            <span className="size-2 shrink-0 rounded-full" style={{ background: palette[i % palette.length] }} />
            <span className="min-w-0 flex-1 truncate" title={s.key}>
              {s.key}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {s.count} · {pct(s.count, sum)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 访问分布地图。
 *
 * 只用气泡层：点密度本来就靠数量表达，再叠热力图在"城市"这个粒度上只会糊成一团。
 * 半径按 count 开方缩放（线性缩放会让大城市压掉其他所有点）。
 */
function DistributionMap({
  points,
  self,
}: {
  points: { label: string; lat: number; lon: number; count: number }[];
  self: { label: string; lat: number; lon: number } | null;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: holder.current,
      style: MAP_STYLE,
      center: [104, 34],
      zoom: 2.6,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const data = {
      type: 'FeatureCollection' as const,
      features: [
        ...points
          .filter((p) => p.lat || p.lon)
          .map((p) => ({
            type: 'Feature' as const,
            properties: { label: p.label, count: p.count, kind: 'visitor' },
            geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
          })),
        ...(self && (self.lat || self.lon)
          ? [
              {
                type: 'Feature' as const,
                properties: { label: self.label, count: 0, kind: 'self' },
                geometry: { type: 'Point' as const, coordinates: [self.lon, self.lat] },
              },
            ]
          : []),
      ],
    };

    const paint = () => {
      if (!map.getSource('visits')) {
        map.addSource('visits', { type: 'geojson', data });
        map.addLayer({
          id: 'visits-bubble',
          type: 'circle',
          source: 'visits',
          paint: {
            'circle-color': ['match', ['get', 'kind'], 'self', '#38bdf8', '#34d399'],
            'circle-opacity': 0.7,
            'circle-stroke-color': '#0b0b0b',
            'circle-stroke-width': 1,
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['sqrt', ['get', 'count']],
              0, ['match', ['get', 'kind'], 'self', 7, 3],
              5, 10,
              20, 22,
            ],
          },
        });
      } else {
        (map.getSource('visits') as maplibregl.GeoJSONSource).setData(data);
      }
    };
    if (map.isStyleLoaded()) paint();
    else map.once('load', paint);
  }, [points, self]);

  return <div ref={holder} className="h-[380px] w-full overflow-hidden rounded-xl" />;
}

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const [hours, setHours] = useState(24);
  const [tab, setTab] = useState<Tab>('access');
  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [access, setAccess] = useState<AccessEvent[]>([]);
  const [security, setSecurity] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [host, setHost] = useState('');

  const load = async (h = hours) => {
    setLoading(true);
    try {
      const data = await fetchAnalytics(h);
      setOverview(data);
      const [rows, sec] = await Promise.all([
        fetchRecentAccess(data.cursor, 300),
        fetchSecurityEvents(300),
      ]);
      setAccess(rows);
      setSecurity(sec);
    } catch (e) {
      toast.error(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(hours);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours]);

  /**
   * 城市比例：**先按名字合并**再排序。
   *
   * IP 库给的是"落点"，同一个城市会有多个点（「广东 · 广州市」在列表里出现过 5 次、
   * 「北京」和「北京市 · 西城区」还分成两条），直接铺开就是七十多行、读不出重点。
   * 合并后坐标按 count 加权，地图上的气泡也跟着合并 —— 少而准，比多而碎强。
   */
  const cities = useMemo(() => {
    const total = overview?.total ?? 0;
    const merged = new Map<string, { label: string; count: number; lat: number; lon: number }>();
    for (const p of overview?.points ?? []) {
      if (p.count <= 0) continue;
      const cur = merged.get(p.label);
      if (cur) {
        cur.count += p.count;
        cur.lat += p.lat * p.count;
        cur.lon += p.lon * p.count;
      } else {
        merged.set(p.label, { label: p.label, count: p.count, lat: p.lat * p.count, lon: p.lon * p.count });
      }
    }
    return [...merged.values()]
      .map((c) => ({ ...c, lat: c.lat / c.count, lon: c.lon / c.count }))
      .sort((a, b) => b.count - a.count)
      .map((c) => ({ ...c, ratio: pct(c.count, total) }));
  }, [overview]);

  /** 地图上用的就是合并后的落点（最多 60 个，够看分布）。 */
  const mapPoints = useMemo(
    () => cities.slice(0, 60).map(({ label, lat, lon, count }) => ({ label, lat, lon, count })),
    [cities],
  );

  const hosts = overview?.hosts ?? [];

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (s: string) => !needle || s.toLowerCase().includes(needle);
    if (tab === 'access') {
      return access.filter(
        (r) =>
          (!host || r.host === host) &&
          (match(r.ip) || match(r.uri) || match(r.ua) || match(r.location)),
      );
    }
    const want = tab === 'bot' ? ['bot'] : ['blocked', 'probe'];
    return security.filter(
      (r) => want.includes(r.kind) && (match(r.ip) || match(r.uri) || match(r.ua) || match(r.reason)),
    );
  }, [tab, access, security, q, host]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('analytics.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('analytics.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <Button
              key={r.hours}
              size="sm"
              variant={hours === r.hours ? 'default' : 'outline'}
              onClick={() => setHours(r.hours)}
            >
              {t(r.labelKey)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: t('analytics.total'), value: overview?.total ?? 0 },
          { label: t('analytics.visitors'), value: overview?.unique_ips ?? 0 },
          { label: t('analytics.cities'), value: cities.length },
          { label: t('analytics.per_minute'), value: perMinute(overview?.per_minute) },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="pt-5">
              <p className="text-[11px] text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardContent className="space-y-3 pt-5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{t('analytics.map_title')}</p>
              <span className="text-[11px] text-muted-foreground">
                {overview?.geo.enabled ? t('analytics.geo_on') : t('analytics.geo_off')}
              </span>
            </div>
            {loading && !overview ? (
              <Skeleton className="h-[380px] w-full rounded-xl" />
            ) : (
              <DistributionMap points={mapPoints} self={overview?.self_location ?? null} />
            )}
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-emerald-400" />
                {t('analytics.legend_visitor')}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-sky-400" />
                {t('analytics.legend_self')}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* 右栏是"比例"：站点一条、城市一条，都是几行就说完的事 */}
        <Card>
          <CardContent className="space-y-3 pt-5">
            <p className="text-sm font-medium">{t('analytics.site_ratio')}</p>
            <SiteDonut data={hosts} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium">{t('analytics.city_ratio')}</p>
            <span className="text-[11px] text-muted-foreground">
              {t('analytics.cities_hint', { n: cities.length })}
            </span>
          </div>
          {/* 只铺前 12 个：全量七十多行既读不完也压不到重点，剩下的是长尾 */}
          {cities.length === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              {overview?.geo.enabled ? t('analytics.no_data') : t('analytics.geo_off')}
            </p>
          ) : (
            <>
              <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                {cities.slice(0, 12).map((c) => (
                  <li key={c.label} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate" title={c.label}>
                        {c.label}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {c.count} · {c.ratio}
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-emerald-500/70" style={{ width: c.ratio }} />
                    </div>
                  </li>
                ))}
              </ul>
              {cities.length > 12 && (
                <p className="text-[11px] text-muted-foreground">
                  {t('analytics.cities_rest', { n: cities.length - 12 })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            {TABS.map(({ id, labelKey, icon: Icon }) => (
              <Button
                key={id}
                size="sm"
                variant={tab === id ? 'default' : 'outline'}
                onClick={() => setTab(id)}
              >
                <Icon />
                {t(labelKey)}
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              {tab === 'access' && (
                <select
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs"
                >
                  <option value="">{t('analytics.all_hosts')}</option>
                  {hosts.map((h) => (
                    <option key={h.key} value={h.key}>
                      {h.key}（{h.count}）
                    </option>
                  ))}
                </select>
              )}
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('analytics.filter_placeholder')}
                className="h-8 w-52 text-xs"
              />
            </div>
          </div>

          {loading && access.length === 0 ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <div className="max-h-[520px] overflow-auto rounded-xl border border-border/60">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-left text-[11px] text-muted-foreground">
                  {tab === 'access' ? (
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_time')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_ip')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_location')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_host')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_request')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_status')}</th>
                    </tr>
                  ) : (
                    <tr>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_last_seen')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_ip')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_kind')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_request')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_hits')}</th>
                      <th className="px-3 py-2 font-medium">{t('analytics.col_ua')}</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                        {t('analytics.no_rows')}
                      </td>
                    </tr>
                  )}
                  {tab === 'access'
                    ? (rows as AccessEvent[]).map((r) => (
                        <tr key={r.id} className="border-t border-border/50">
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                            {r.time}
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.ip}</td>
                          <td className="px-3 py-1.5">{r.location}</td>
                          <td className="px-3 py-1.5 font-mono">{r.host}</td>
                          <td className="max-w-[320px] truncate px-3 py-1.5 font-mono" title={`${r.method} ${r.uri}`}>
                            {r.method} {r.uri}
                          </td>
                          <td className="px-3 py-1.5">
                            <span
                              className={cn(
                                'tabular-nums',
                                r.status >= 500
                                  ? 'text-destructive'
                                  : r.status >= 400
                                    ? 'text-amber-500'
                                    : 'text-emerald-500',
                              )}
                            >
                              {r.status}
                            </span>
                          </td>
                        </tr>
                      ))
                    : (rows as SecurityEvent[]).map((r) => (
                        <tr key={r.id} className="border-t border-border/50">
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                            {r.last_seen}
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono">{r.ip}</td>
                          <td className="px-3 py-1.5">
                            <Badge variant={r.kind === 'bot' ? 'secondary' : 'destructive'} className="h-4 px-1 text-[10px]">
                              {r.kind}
                            </Badge>
                          </td>
                          <td className="max-w-[300px] truncate px-3 py-1.5 font-mono" title={`${r.method} ${r.uri}`}>
                            {r.uri || r.reason}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums">{r.hits}</td>
                          <td className="max-w-[260px] truncate px-3 py-1.5 text-muted-foreground" title={r.ua}>
                            {r.ua || '—'}
                          </td>
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t('analytics.rows_hint', { n: rows.length })}
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Globe2 className="size-3.5" />
        {overview?.geo.note}
      </div>
    </div>
  );
}
