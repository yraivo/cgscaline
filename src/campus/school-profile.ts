import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GcjCoord } from '../track/types.js';

export interface RouteProfile {
  name: string;
  nameEn?: string;
  stadiumInfieldRadiusM?: number;
  boundaryGcj02?: GcjCoord[];
}

export interface SchoolProfile {
  name: string;
  nameEn: string;
  schoolId?: string;
  provinceCode: string;
  randomCode: string;
  baseUrl: string;
  defaultRouteId: string;
  routes: Record<string, RouteProfile>;
}

export const DEFAULT_BASE_URL = 'https://cgapp.chingo.cn/cgapp-server/';

export const DEFAULT_SCHOOL_PROFILE: SchoolProfile = Object.freeze({
  name: '校区运动中心',
  nameEn: 'CAMPUS TELEMETRY',
  provinceCode: '00',
  randomCode: '00',
  baseUrl: DEFAULT_BASE_URL,
  defaultRouteId: '27',
  routes: {
    '27': { name: '2号田径场', nameEn: 'Track Sector #2', stadiumInfieldRadiusM: 26 },
    '24': { name: '校园环线', nameEn: 'Campus Loop' },
  },
});

function sanitizeCoords(raw: unknown): GcjCoord[] | undefined {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 500) return undefined;
  const out: GcjCoord[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) return undefined;
    const lat = Number(item[0]), lng = Number(item[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return undefined;
    }
    out.push([lat, lng]);
  }
  return out;
}

function sanitizeBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
      return undefined;
    }
    return u.href.replace(/\/?$/, '/');
  } catch {
    return undefined;
  }
}

export function loadSchoolProfile(root: string | null | undefined): { profile: SchoolProfile; fromDisk: boolean } {
  if (!root) return { profile: DEFAULT_SCHOOL_PROFILE, fromDisk: false };
  const filePath = join(root, 'school-profile.json');
  if (!existsSync(filePath)) return { profile: DEFAULT_SCHOOL_PROFILE, fromDisk: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { profile: DEFAULT_SCHOOL_PROFILE, fromDisk: false };
    }
    const baseUrl = sanitizeBaseUrl(parsed.baseUrl) ?? DEFAULT_SCHOOL_PROFILE.baseUrl;
    const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim().slice(0, 60) : DEFAULT_SCHOOL_PROFILE.name;
    const nameEn = typeof parsed.nameEn === 'string' && parsed.nameEn.trim() ? parsed.nameEn.trim().slice(0, 60) : name;
    const schoolId = typeof parsed.schoolId === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(parsed.schoolId.trim())
      ? parsed.schoolId.trim()
      : undefined;
    const provinceCode = typeof parsed.provinceCode === 'string' && /^[a-zA-Z0-9_-]{1,16}$/.test(parsed.provinceCode.trim())
      ? parsed.provinceCode.trim()
      : DEFAULT_SCHOOL_PROFILE.provinceCode;
    const randomCode = typeof parsed.randomCode === 'string' && /^[a-zA-Z0-9_-]{1,16}$/.test(parsed.randomCode.trim())
      ? parsed.randomCode.trim()
      : DEFAULT_SCHOOL_PROFILE.randomCode;
    const defaultRouteId = typeof parsed.defaultRouteId === 'string' && /^[0-9]{1,8}$/.test(parsed.defaultRouteId.trim())
      ? parsed.defaultRouteId.trim()
      : DEFAULT_SCHOOL_PROFILE.defaultRouteId;

    const routes: Record<string, RouteProfile> = {};
    if (parsed.routes && typeof parsed.routes === 'object' && !Array.isArray(parsed.routes)) {
      for (const [routeId, rawRoute] of Object.entries(parsed.routes as Record<string, unknown>)) {
        if (!/^[0-9]{1,8}$/.test(routeId) || !rawRoute || typeof rawRoute !== 'object' || Array.isArray(rawRoute)) continue;
        const r = rawRoute as Record<string, unknown>;
        const rName = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : `Route ${routeId}`;
        const rNameEn = typeof r.nameEn === 'string' && r.nameEn.trim() ? r.nameEn.trim().slice(0, 60) : undefined;
        const boundaryGcj02 = sanitizeCoords(r.boundaryGcj02);
        const infield = Number(r.stadiumInfieldRadiusM);
        routes[routeId] = {
          name: rName,
          ...(rNameEn ? { nameEn: rNameEn } : {}),
          ...(boundaryGcj02 ? { boundaryGcj02 } : {}),
          ...(Number.isFinite(infield) && infield > 0 && infield < 120 ? { stadiumInfieldRadiusM: infield } : {}),
        };
      }
    }
    return {
      profile: {
        name,
        nameEn,
        ...(schoolId ? { schoolId } : {}),
        provinceCode,
        randomCode,
        baseUrl,
        defaultRouteId,
        routes: Object.keys(routes).length ? routes : DEFAULT_SCHOOL_PROFILE.routes,
      },
      fromDisk: true,
    };
  } catch {
    return { profile: DEFAULT_SCHOOL_PROFILE, fromDisk: false };
  }
}
