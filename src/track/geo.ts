import type { GcjCoord } from "./types.js";

const PI = Math.PI;
const AXIS = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lat: number, lng: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}

function delta(lat: number, lng: number) {
  const dLat = transformLat(lng - 105, lat - 35);
  const dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  return {
    lat: (dLat * 180) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI),
    lng: (dLng * 180) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI),
  };
}

export function wgs84ToGcj02([lat, lng]: GcjCoord): GcjCoord {
  if (outOfChina(lat, lng)) return [lat, lng];
  const d = delta(lat, lng);
  return [lat + d.lat, lng + d.lng];
}

export function gcj02ToWgs84(coord: GcjCoord): GcjCoord {
  if (outOfChina(coord[0], coord[1])) return coord;
  let guess: GcjCoord = coord;
  for (let i = 0; i < 8; i += 1) {
    const converted = wgs84ToGcj02(guess);
    const next: GcjCoord = [guess[0] + coord[0] - converted[0], guess[1] + coord[1] - converted[1]];
    if (distanceMeters(next, guess) < 0.01) return next;
    guess = next;
  }
  return guess;
}

export function distanceMeters(a: GcjCoord, b: GcjCoord) {
  const r = 6371000;
  const p1 = (a[0] * PI) / 180;
  const p2 = (b[0] * PI) / 180;
  const dp = ((b[0] - a[0]) * PI) / 180;
  const dl = ((b[1] - a[1]) * PI) / 180;
  const value = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(value)));
}

export function pointInPolygon(point: GcjCoord, polygon: GcjCoord[]) {
  if (polygon.length < 3) return true;
  let inside = false;
  const [lat, lng] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]!;
    const [yj, xj] = polygon[j]!;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function projectLocal(point: GcjCoord, origin: GcjCoord): [number, number] {
  const metersLat = 110540;
  const metersLng = 111320 * Math.cos((origin[0] * PI) / 180);
  return [(point[1] - origin[1]) * metersLng, (point[0] - origin[0]) * metersLat];
}

export function unprojectLocal([x, y]: [number, number], origin: GcjCoord): GcjCoord {
  const metersLat = 110540;
  const metersLng = 111320 * Math.cos((origin[0] * PI) / 180);
  return [origin[0] + y / metersLat, origin[1] + x / metersLng];
}
