import { useEffect, useRef } from 'react';
import { landPoints, toVec3, type Vec3 } from '../_lib/land-mask';
import type { AccessEvent, GeoPoint } from '../_api';

/**
 * 地球。
 *
 * 用 canvas 2D 手搓，不引 three.js：这里要的是"一屏好看的动画"，而 three 的
 * 代价（几百 KB + 一套渲染器的生命周期）换不来额外的效果 —— 陆地点阵、脉冲
 * 标记、飞线，全是球面上的点与线，2D 投影够用，还能完全按自己的节奏控制颜色
 * 和辉光。
 *
 * 三个图层，从后往前：
 *   1. 陆地点阵 —— 按 cos(纬度) 抽稀，背面的点按深度调暗而不是直接丢掉，
 *      明暗渐变比一刀切自然。
 *   2. 落点脉冲 —— 有访问的地方一圈圈扩散，刚来的那次最亮。
 *   3. 飞线 —— 从落点划一条弧到这台服务器所在的位置。没有服务器坐标就不画：
 *      画一条指向"随便哪儿"的弧线是在编数据。
 */

interface Props {
  /** 有经纬度的访问落点。 */
  points: GeoPoint[];
  /** 这台服务器的位置；为空时只画落点，不画飞线。 */
  self: GeoPoint | null;
  /** 最新一条访问，用来决定哪个点该闪光。 */
  latest: AccessEvent | null;
}

/** 已生成的飞线，活到自己淡完为止。 */
type Arc = { from: Vec3; to: Vec3; born: number; life: number };

const DEG = Math.PI / 180;

/**
 * 陆地点的亮度档位。
 *
 * 原来是"每个点现算一条 `rgba(…)` 字符串再交给 fillStyle" —— 八千个点、每帧
 * 八千次字符串拼接 + 八千次样式解析 + 八千次 fillRect。现在按深度分 6 档，
 * 每档攒一条 Path2D，一帧只改 6 次颜色、只画 6 次。省下来的是实打实的主线程时间，
 * 而 6 档明暗在屏幕上看不出和连续渐变的区别。
 */
const LAND_SHADES = 6;
const LAND_STYLES = Array.from(
  { length: LAND_SHADES },
  (_, i) => `rgba(125, 211, 252, ${0.12 + ((i + 0.5) / LAND_SHADES) * 0.55})`,
);

/**
 * 帧率上限。
 *
 * 这台屏是 24 小时开着的：30fps 的慢速自转看不出和 60fps 的区别，但主线程占用
 * 直接减半 —— 少一半的发热和风扇声，也留出余量给真正要紧的事。
 */
const FRAME_MS = 1000 / 30;

export function Globe({ points, self, latest }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 陆地点只算一次：每帧重算 8 千个点是白烧 CPU。 */
  const landRef = useRef<Vec3[] | null>(null);
  /** 动画循环里要读最新值，放 ref 免得 effect 反复重启。 */
  const pointsRef = useRef(points);
  const selfRef = useRef(self);
  const arcsRef = useRef<Arc[]>([]);
  const seenRef = useRef(new Set<number>());
  /**
   * 落点的球面坐标只跟经纬度有关，跟时间无关 —— 每帧再算一次 toVec3 是白算。
   * 数据变了才重算，动画循环只读。
   */
  const geoRef = useRef<{ v: Vec3; point: GeoPoint }[]>([]);
  const homeRef = useRef<Vec3 | null>(null);

  pointsRef.current = points;
  selfRef.current = self;

  useEffect(() => {
    geoRef.current = points.map((point) => ({
      v: toVec3(point.lat, point.lon, 1.004),
      point,
    }));
  }, [points]);

  useEffect(() => {
    homeRef.current = self ? toVec3(self.lat, self.lon, 1.006) : null;
  }, [self]);

  // 新来的访问：如果它的落点有坐标，就从那儿划一条弧到服务器。
  useEffect(() => {
    if (!latest || seenRef.current.has(latest.id)) return;
    seenRef.current.add(latest.id);
    // 集合别无限长。
    if (seenRef.current.size > 500) seenRef.current = new Set([latest.id]);

    const target = selfRef.current;
    if (!target || !latest.lat || !latest.lon) return;
    arcsRef.current.push({
      from: toVec3(latest.lat, latest.lon, 1.002),
      to: toVec3(target.lat, target.lon, 1.002),
      born: performance.now(),
      // 2.2 秒：地球 30 秒转一圈，弧线两端同时朝向观察者的窗口本来就只有一半时间，
      // 太快的话一眨眼就没了。
      life: 2200,
    });
    if (arcsRef.current.length > 24) arcsRef.current.shift();
  }, [latest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!landRef.current) landRef.current = landPoints().map((p) => toVec3(p.lat, p.lon));

    let raf = 0;
    let width = 0;
    let height = 0;
    let lastDraw = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (time: number) => {
      raf = requestAnimationFrame(draw);
      if (width === 0 || height === 0) return;
      // 限帧：显示器是 60/120Hz，但地球 30 秒才转一圈，多出来的帧只是白烧 CPU。
      if (time - lastDraw < FRAME_MS) return;
      lastDraw = time;

      // 缓慢自转。0.02°/ms 大约 30 秒一圈 —— 大屏是长时间开着的，转快了晃眼。
      const spin = (time * 0.02) * DEG;
      const radius = Math.min(width, height) * 0.42;
      const cx = width / 2;
      const cy = height / 2;
      // 略微俯视：北极往观察者这边倒一点，看到的就是北半球（那是绝大多数站点
      // 所在的地方）。正对着赤道的球看起来像贴在墙上的圆，抬一点才有立体感。
      const tilt = 15 * DEG;

      // 三角函数每帧只算一次。之前是写在 project 里面的 —— 八千个点 × 每帧
      // 四个三角函数，等于每秒几百万次无谓调用，这是这块最贵的一行。
      const cosSpin = Math.cos(spin);
      const sinSpin = Math.sin(spin);
      const cosTilt = Math.cos(tilt);
      const sinTilt = Math.sin(tilt);

      const project = (v: Vec3) => {
        // 先绕 Y 轴自转，再绕 X 轴倾斜。
        const x1 = v.x * cosSpin + v.z * sinSpin;
        const z1 = -v.x * sinSpin + v.z * cosSpin;
        const y2 = v.y * cosTilt - z1 * sinTilt;
        const z2 = v.y * sinTilt + z1 * cosTilt;
        // `facing` 是"这一点在球的哪一侧"：+1 正对观察者，-1 在球背面。
        //
        // 这里以前直接拿 z2 当"深度"用，而且判定写的是"z 大于阈值就跳过" ——
        // 于是被跳过的恰恰是**正对我们**的那半边，画出来的是球背面透过来的影像。
        // 从外面看球的背面，左右是反的，所以整个地球看起来是镜像的。
        return { x: cx + x1 * radius, y: cy - y2 * radius, facing: z2 };
      };

      ctx.clearRect(0, 0, width, height);

      // 球体本身：一圈极淡的径向渐变当"大气"，让球不至于悬在虚空里。
      const glow = ctx.createRadialGradient(cx, cy, radius * 0.7, cx, cy, radius * 1.25);
      glow.addColorStop(0, 'rgba(56, 189, 248, 0.10)');
      glow.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.3, 0, Math.PI * 2);
      ctx.fill();

      // 1. 陆地点阵：按深度分档攒路径，最后每档一次性填充。
      const paths = Array.from({ length: LAND_SHADES }, () => new Path2D());
      for (const v of landRef.current!) {
        // 就地展开，不调 project()：那会为每个点分配一个对象，八千个点就是每帧
        // 八千次分配 —— 光 GC 就够把帧率啃掉一截。
        const x1 = v.x * cosSpin + v.z * sinSpin;
        const z1 = -v.x * sinSpin + v.z * cosSpin;
        const y2 = v.y * cosTilt - z1 * sinTilt;
        const z2 = v.y * sinTilt + z1 * cosTilt;
        // 只画正对观察者的那半边；留 0.15 的余量，边缘不至于缺一圈。
        if (z2 < 0.15) continue;
        const depth = (z2 - 0.15) / 0.85;
        const bucket = Math.min(LAND_SHADES - 1, (depth * LAND_SHADES) | 0);
        const size = 0.9 + ((bucket + 0.5) / LAND_SHADES) * 1.0;
        paths[bucket].rect(cx + x1 * radius, cy - y2 * radius, size, size);
      }
      for (let i = 0; i < LAND_SHADES; i++) {
        ctx.fillStyle = LAND_STYLES[i];
        ctx.fill(paths[i]);
      }

      // 2. 落点脉冲：常驻的小点 + 一圈随时间扩大的环。
      for (const { v, point } of geoRef.current) {
        const p = project(v);
        if (p.facing < 0.15) continue;
        const weight = Math.min(1, 0.35 + Math.log10(point.count + 1) * 0.4);
        const phase = ((time / 1800) + point.lat * 0.01 + point.lon * 0.01) % 1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, 2 + weight * 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(52, 211, 153, ${0.5 + weight * 0.4})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + phase * 16, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(52, 211, 153, ${0.35 * (1 - phase)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // 服务器所在的位置：一个方块，和访客的圆点区分开。
      const home = selfRef.current;
      if (home && (home.lat || home.lon) && homeRef.current) {
        const p = project(homeRef.current);
        if (p.facing >= 0.15) {
          ctx.fillStyle = 'rgba(248, 250, 252, 0.95)';
          ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
          ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // 3. 飞线：二次贝塞尔往上拱，终点在服务器，头部一个小亮点。
      const arcs = arcsRef.current;
      for (let i = arcs.length - 1; i >= 0; i--) {
        const arc = arcs[i];
        const age = (time - arc.born) / arc.life;
        if (age >= 1) {
          arcs.splice(i, 1);
          continue;
        }
        const a = project(arc.from);
        const b = project(arc.to);
        // 两端都得在正对我们的这半球上，否则弧线会穿过球体画出来。
        if (a.facing < 0.15 || b.facing < 0.15) continue;
        const lift = Math.hypot(b.x - a.x, b.y - a.y) * 0.35;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2 - lift;

        const alpha = Math.sin(age * Math.PI) * 0.9;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // 光点沿着同一条曲线跑，走到头就灭。
        const t = age;
        const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
        const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(224, 242, 254, ${alpha})`;
        ctx.fill();
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="size-full" aria-hidden />;
}
