/**
 * 将原始经纬度序列归一化为无量纲 [0..1, 0..1, speedNorm] 微缩轨迹点列。
 * 不保留真实绝对经纬度，既缩减 IPC 体积，也避免在界面层暴露地理位置。
 */
export type MinimapPoint = readonly [number, number, number];

interface RawCoord {
  lat: number;
  lng: number;
  speed: number;
}

function parseArray(raw: unknown): unknown[] | undefined {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.length > 2) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readCoord(item: unknown): RawCoord | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  if (o.v === 0 || o.validFlag === 0) return undefined;
  const lat = Number(o.a ?? o.lat ?? o.latitude ?? o.latGcj02);
  const lng = Number(o.o ?? o.lng ?? o.lon ?? o.longitude ?? o.lngGcj02);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return undefined;
  const speedRaw = Number(o.s ?? o.speed ?? o.speedKmh ?? 0);
  return { lat, lng, speed: Number.isFinite(speedRaw) && speedRaw >= 0 ? speedRaw : 0 };
}

export function extractMinimap(raw: unknown, maxSamples = 180): MinimapPoint[] | undefined {
  const arr = parseArray(raw);
  if (!arr || arr.length < 2) return undefined;
  const coords: RawCoord[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = readCoord(arr[i]);
    if (c) coords.push(c);
  }
  if (coords.length < 2) return undefined;

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let minSpd = Infinity, maxSpd = -Infinity;
  for (const c of coords) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
    if (c.speed > 0) {
      if (c.speed < minSpd) minSpd = c.speed;
      if (c.speed > maxSpd) maxSpd = c.speed;
    }
  }

  const midLat = (minLat + maxLat) * 0.5;
  const midLng = (minLng + maxLng) * 0.5;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const spanX = (maxLng - minLng) * cosLat;
  const spanY = maxLat - minLat;
  const span = Math.max(spanX, spanY);
  if (!(span > 1e-7)) return undefined;

  const spdSpan = maxSpd > minSpd ? maxSpd - minSpd : 0;
  const count = Math.min(coords.length, Math.max(2, Math.floor(maxSamples)));
  const out: MinimapPoint[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const idx = i === count - 1 ? coords.length - 1 : Math.round((i * (coords.length - 1)) / (count - 1));
    const c = coords[idx]!;
    const nx = 0.5 + ((c.lng - midLng) * cosLat) / span;
    const ny = 0.5 - (c.lat - midLat) / span;
    const ns = spdSpan > 0.1 && c.speed > 0
      ? Math.max(0, Math.min(1, (c.speed - minSpd) / spdSpan))
      : i / (count - 1);
    out[i] = [
      Math.round(Math.max(0, Math.min(1, nx)) * 10000) / 10000,
      Math.round(Math.max(0, Math.min(1, ny)) * 10000) / 10000,
      Math.round(ns * 1000) / 1000,
    ];
  }
  return out;
}

export function extractMinimapFromDetail(data: Record<string, unknown>): MinimapPoint[] | undefined {
  const direct = extractMinimap(data.coordinatestr ?? data.coordinate);
  if (direct) return direct;
  const poly = parseArray(data.routepolylinelist);
  if (!poly?.length) return undefined;
  const flattened: unknown[] = [];
  for (const entry of poly) {
    if (Array.isArray(entry)) flattened.push(...entry);
    else if (entry && typeof entry === 'object') {
      const sub = (entry as Record<string, unknown>).points ?? (entry as Record<string, unknown>).list ?? (entry as Record<string, unknown>).latLngList;
      const arr = parseArray(sub);
      if (arr) flattened.push(...arr);
      else flattened.push(entry);
    }
  }
  return extractMinimap(flattened);
}
