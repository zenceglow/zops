import { LAND_H, LAND_MASK_B64, LAND_W } from './land-data';

export type Vec3 = { x: number; y: number; z: number };

/**
 * 把陆地掩码解成经纬网格上的点。
 *
 * 每行按 `cos(lat)` 抽稀：等经纬网在地球上不是等面积的，两极那一圈格子在球面上
 * 挤成一点，照原样打点会得到两个发白的结块。抽稀之后全球点距才均匀。
 */
export function landPoints(): { lat: number; lon: number }[] {
  const bytes = decodeBase64(LAND_MASK_B64);
  const points: { lat: number; lon: number }[] = [];
  const step = 360 / LAND_W;

  for (let j = 0; j < LAND_H; j++) {
    const lat = 90 - (j + 0.5) * step;
    const keep = Math.max(1, Math.round(1 / Math.max(0.12, Math.cos((lat * Math.PI) / 180))));
    for (let i = 0; i < LAND_W; i += keep) {
      const idx = j * LAND_W + i;
      if ((bytes[idx >> 3] >> (idx & 7)) & 1) {
        points.push({ lat, lon: -180 + (i + 0.5) * step });
      }
    }
  }
  return points;
}

/** 经纬度 → 单位球上的点。0° 经线朝向 +Z，北极朝 +Y。 */
export function toVec3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = (lat * Math.PI) / 180;
  const theta = (lon * Math.PI) / 180;
  const c = Math.cos(phi);
  return {
    x: c * Math.sin(theta) * radius,
    y: Math.sin(phi) * radius,
    z: c * Math.cos(theta) * radius,
  };
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
