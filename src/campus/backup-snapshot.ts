import { deviceProfiles } from '../core/device-profiles.js';
import { validDevice } from '../core/device-identity.js';
import { UserError, type Device } from '../core/model.js';

export function parseSensorText(raw: string): number[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const body = trimmed.replace(/^\[+/, '').replace(/\]+$/, '');
  const nums: number[] = [];
  for (const part of body.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const v = Number(s);
    if (!Number.isFinite(v)) return undefined;
    nums.push(v);
    if (nums.length >= 100_000) return undefined;
  }
  return nums.length >= 10 ? nums : undefined;
}

export interface BackupSessionHint {
  token: string;
  secret: string;
  loginOutTime: string;
  name?: string;
  gender?: string;
}

export interface BackupHints {
  username?: string;
  serverUrl?: string;
  schoolId?: string;
  model?: string;
  androidId?: string;
  hardware?: { manufacturer: string; model: string; androidRelease: string; sdk: string; buildId: string };
  session?: BackupSessionHint;
}

export interface SportSnapshot { db?: Buffer; sensors: Map<string, number[]>; hints?: BackupHints }

export interface JwtClaims {
  sub?: string;
  schoolId?: string;
  exp?: number;
}

export function parseJwtClaims(token: string): JwtClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !p || !/^[A-Za-z0-9_-]+$/.test(p))) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const sub = typeof raw.sub === 'string' && /^[a-zA-Z0-9_@.-]{2,80}$/.test(raw.sub) ? raw.sub : undefined;
    const schoolRaw = raw.school_id ?? raw.schoolId;
    const schoolId = (typeof schoolRaw === 'string' || typeof schoolRaw === 'number') &&
      /^[a-zA-Z0-9_-]{1,32}$/.test(String(schoolRaw).trim()) ? String(schoolRaw).trim() : undefined;
    const exp = typeof raw.exp === 'number' && Number.isFinite(raw.exp) ? raw.exp : undefined;
    return { ...(sub ? { sub } : {}), ...(schoolId ? { schoolId } : {}), ...(exp !== undefined ? { exp } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Parse app-scoped Android ID from Umeng's IdTracking cache (`f/umeng_it.cache`).
 * Supports both Apache Thrift TCompactProtocol and TBinaryProtocol encodings of `map<string, IdSnapshot>`.
 * Rejects all-zero values and ambiguous files containing conflicting matches.
 */
export function parseUmengItCache(buf: Buffer): string | undefined {
  if (!buf || buf.length < 28 || buf.length > 65_536) return undefined;
  const keyBytes = Buffer.from('android_id', 'ascii');
  const found = new Set<string>();
  const acceptHex = (slice: Buffer) => {
    if (slice.length !== 16) return;
    const text = slice.toString('ascii');
    if (/^[a-fA-F0-9]{16}$/.test(text) && !/^0+$/.test(text)) found.add(text);
  };

  let idx = 0;
  while ((idx = buf.indexOf(keyBytes, idx)) >= 0) {
    const after = idx + keyBytes.length;
    // 1. TCompactProtocol: varint len 0x0a + "android_id" + (0x18 [delta=1, binary] | 0x08 0x00 0x01) + varint len 0x10 + 16 hex
    if (idx >= 1 && buf[idx - 1] === 0x0a) {
      if (after + 18 <= buf.length && buf[after] === 0x18 && buf[after + 1] === 0x10) {
        acceptHex(buf.subarray(after + 2, after + 18));
      } else if (after + 20 <= buf.length && buf[after] === 0x08 && buf[after + 1] === 0x00 && buf[after + 2] === 0x01 && buf[after + 3] === 0x10) {
        acceptHex(buf.subarray(after + 4, after + 20));
      }
    }
    // 2. TBinaryProtocol: int32BE len 0x0000000a + "android_id" + T_STRING(0x0b) + fieldId(0x0001) + int32BE len(0x00000010) + 16 hex
    if (idx >= 4 && buf.readUInt32BE(idx - 4) === 10 && after + 23 <= buf.length) {
      if (buf[after] === 0x0b && buf.readUInt16BE(after + 1) === 1 && buf.readUInt32BE(after + 3) === 16) {
        acceptHex(buf.subarray(after + 7, after + 23));
      }
    }
    idx = after;
  }
  return found.size === 1 ? [...found][0] : undefined;
}

function xmlValue(xml: string, name: string, optional = false): string | undefined {
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) throw new Error('unsupported XML');
  const elements = xml.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<string\s+name=(["'])([^"']+)\1\s*>([^<]*)<\/string\s*>/g);
  const values = [...elements].filter(m => m[2] === name);
  if (values.length === 0 && optional) return undefined;
  if (values.length !== 1) throw new Error('missing or duplicate preference');
  const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return values[0]![3]!.replace(/&([^;]+);/g, (_, key: string) => {
    if (Object.hasOwn(entities, key)) return entities[key]!;
    if (/^#\d+$/.test(key)) return String.fromCodePoint(Number(key.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(key)) return String.fromCodePoint(parseInt(key.slice(2), 16));
    throw new Error('unsupported XML entity');
  }).trim();
}

export function backupHints(prefs: Map<string, string>, umengCache?: Buffer): BackupHints | undefined {
  try {
    const user = prefs.get('USERINFO'), school = prefs.get('SCHOOL'), config = prefs.get('umzid_general_config'), header = prefs.get('HEADER');
    const hints: BackupHints = {};
    let displayName: string | undefined;
    let gender: string | undefined;
    if (user) {
      const username = xmlValue(user, 'USERXH');
      if (!username || !/^[a-zA-Z0-9_@.-]{2,80}$/.test(username)) return;
      hints.username = username;
      const xm = xmlValue(user, 'USERNAME', true);
      if (xm && xm.length <= 40) displayName = xm;
      const xb = xmlValue(user, 'USER_SEX', true);
      if (xb === '1' || xb === '2') gender = xb;
    }
    if (school) {
      const rawUrl = xmlValue(school, 'SERVERURL');
      if (!rawUrl) return;
      const url = new URL(rawUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
      hints.serverUrl = url.href.replace(/\/?$/, '/');
      const sid = xmlValue(school, 'SCHOOL_ID', true);
      if (sid && /^[a-zA-Z0-9_-]{1,32}$/.test(sid)) hints.schoolId = sid;
    }
    if (config) {
      const rawUabc = xmlValue(config, 'uabc');
      const model = rawUabc ? JSON.parse(rawUabc)?.model : undefined;
      if (typeof model === 'string' && /^[\w. -]{1,64}$/.test(model)) hints.model = model;
    }
    if (umengCache) {
      const aid = parseUmengItCache(umengCache);
      if (aid) hints.androidId = aid;
    }
    if (header && hints.username && hints.serverUrl) {
      const token = xmlValue(header, 'TOKEN', true);
      const secret = xmlValue(header, 'SECRET', true);
      const loginOutTime = xmlValue(header, 'LOGIN_OUT_TIME', true);
      if (token && secret && secret.length >= 16 && loginOutTime && /^\d{10,16}$/.test(loginOutTime) && Number(loginOutTime) > Date.now()) {
        const claims = parseJwtClaims(token);
        if (claims?.sub === hints.username && (!claims.exp || claims.exp * 1000 > Date.now()) &&
          (!claims.schoolId || !hints.schoolId || claims.schoolId === hints.schoolId)) {
          hints.session = {
            token,
            secret,
            loginOutTime,
            ...(displayName ? { name: displayName } : {}),
            ...(gender ? { gender } : {}),
          };
        }
      }
    }
    return Object.keys(hints).length ? hints : undefined;
  } catch { return; }
}

function inferVendorFromModel(model: string): string {
  const m = model.trim();
  if (/^(?:2\d{4}|M20\d{2}|Redmi|Mi\b)/i.test(m)) return 'Xiaomi';
  if (/^V2\d{3}/i.test(m)) return 'vivo';
  if (/^(?:P[HJ][A-Z]\d+|CPH\d+)/i.test(m)) return 'OPPO';
  if (/^(?:KB|LE|NE|PJ[DE])\d+/i.test(m)) return 'OnePlus';
  if (/^RMX\d+/i.test(m)) return 'realme';
  if (/^(?:BVL|ELI|PGT|frias|ANY|MAG)-/i.test(m)) return 'HONOR';
  if (/^(?:BRA|ALN|NOH|CET|Pura)-/i.test(m)) return 'HUAWEI';
  if (/^SM-[A-Z0-9]+/i.test(m)) return 'samsung';
  if (/^Pixel\b/i.test(m)) return 'Google';
  return 'Xiaomi';
}

export function resolvePhoneDevice(hints?: BackupHints): Device | undefined {
  if (!hints?.androidId || !/^[a-fA-F0-9]{16}$/.test(hints.androidId) || /^0+$/.test(hints.androidId)) return undefined;
  const androidId = hints.androidId;
  if (hints.hardware) {
    const candidate: Device = { ...hints.hardware, appVersion: '3.0.0', androidId };
    if (validDevice(candidate)) return candidate;
  }
  if (hints.model) {
    const preset = Object.values(deviceProfiles).find(p => p.model.toLowerCase() === hints.model!.trim().toLowerCase());
    if (preset) {
      const candidate: Device = { ...preset, androidId };
      if (validDevice(candidate)) return candidate;
    }
    const custom: Device = {
      ...deviceProfiles.xiaomi14,
      manufacturer: inferVendorFromModel(hints.model),
      model: hints.model.trim(),
      androidId,
    };
    if (validDevice(custom)) return custom;
  }
  const fallback: Device = { ...deviceProfiles.xiaomi, androidId };
  return validDevice(fallback) ? fallback : undefined;
}

export class SnapshotCollector {
  private groups = new Map<string, { snapshot: SportSnapshot; prefs: Map<string, string>; umengCache?: Buffer; ambiguous: boolean }>();
  private nested: SportSnapshot[] = [];
  addNested(snapshot: SportSnapshot) { if (snapshot.db) this.nested.push(snapshot); }
  add(path: string, size: number, read: () => Buffer) {
    if (/^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/.test(path)) return;
    path = path.replace(/^(?:\.\/)+/, '');
    const pkg = /(?:^|\/)apps\/([^/]+)\//.exec(path);
    if (pkg && pkg[1] !== 'net.crigh.cgsport') return;
    const db = /^(.*?)(?:(?:db|databases)\/)?ygty_mysport\.db$/i.exec(path);
    const pref = /^(.*?)(?:sp|shared_prefs)\/(USERINFO|SCHOOL|HEADER|umzid_general_config)\.xml$/.exec(path);
    const cache = /^(.*?)(?:f|files)\/umeng_it\.cache$/i.exec(path);
    const sensor = /^(.*?)(?:(?:f|files)\/)?sensor(?:_log)?\/([\w-]{8,80})\.txt$/i.exec(path);
    const root = (db ?? pref ?? cache ?? sensor)?.[1];
    if (root === undefined || (root && !root.endsWith('/'))) return;
    let group = this.groups.get(root);
    if (!group) {
      group = { snapshot: { sensors: new Map() }, prefs: new Map(), ambiguous: false };
      this.groups.set(root, group);
    }
    if (db) {
      if (group.snapshot.db) throw new UserError('备份含多个同名记录库，请单独选择一个数据库。');
      group.snapshot.db = read();
    } else if (pref) {
      const key = pref[2]!;
      if (group.prefs.has(key) || size <= 0 || size > 65536) { group.ambiguous = true; return; }
      try { group.prefs.set(key, read().toString('utf8')); } catch { group.ambiguous = true; }
    } else if (cache) {
      if (group.umengCache || size <= 0 || size > 65536) { group.ambiguous = true; return; }
      try { group.umengCache = Buffer.from(read()); } catch { group.ambiguous = true; }
    } else if (sensor && size > 10 && size < 4_000_000) {
      const data = parseSensorText(read().toString('utf8'));
      if (data) group.snapshot.sensors.set(sensor[2]!, data);
    }
  }
  finish(): SportSnapshot {
    const results = [...this.nested];
    for (const { snapshot, prefs, umengCache, ambiguous } of this.groups.values()) {
      if (snapshot.db) results.push({ ...snapshot, hints: ambiguous ? undefined : backupHints(prefs, umengCache) });
    }
    if (results.length > 1) throw new UserError('备份含多个记录库快照，请单独选择一份。');
    return results[0] ?? { sensors: new Map() };
  }
}
