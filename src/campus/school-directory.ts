import { createHash } from 'node:crypto';
import { UPDATE_BASE, UserError } from '../core/model.js';

const APP_KEY = 'cgsoft';
const APP_SECRET = '6d3121b650e42855976d0f70dd2048e4';
const SIGN_PATH = '/api/school';
const XJTU_SERVER_URL = 'http://ggtypt.xjtu.edu.cn/cgapp-server/';

export interface SchoolDirectoryEntry {
  id: string;
  name: string;
  nameEn: string;
  code: string;
  provinceCode: string;
  randomCode: string;
  baseUrl: string;
  loginType?: string;
  loginUrl?: string;
}

export function normalizeSchoolServerUrl(rawUrl: unknown, code = ''): string | undefined {
  if (code.trim().toLowerCase() === 'xjtu') return XJTU_SERVER_URL;
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return undefined;
  // 兼容个别高校后台误填重复拼接 URL（如 http://x/cgapp-server/http://x/cgapp-server/）
  let cleaned = rawUrl.trim();
  const dupIdx = cleaned.slice(8).search(/https?:\/\//i);
  if (dupIdx >= 0) cleaned = cleaned.slice(0, dupIdx + 8);
  try {
    const u = new URL(cleaned);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
      return undefined;
    }
    return u.href.replace(/\/?$/, '/');
  } catch {
    return undefined;
  }
}

export function schoolDirectoryRequest(now = Date.now()) {
  const fields: Record<string, string> = { page: '-1' };
  const timestamp = String(now);
  const kv = Object.keys(fields).sort().map(k => k + fields[k]).join('');
  const sign = createHash('md5').update(APP_SECRET + SIGN_PATH + kv + timestamp + ' ' + APP_SECRET).digest('hex');
  const query = new URLSearchParams({ ...fields, app_key: APP_KEY, timestamp, sign });
  return {
    url: `${UPDATE_BASE}api/school?${query}`,
    headers: { Accept: 'application/json', 'app-key': APP_KEY },
  };
}

export async function fetchSchoolDirectory(fetcher: typeof fetch = fetch): Promise<SchoolDirectoryEntry[]> {
  const req = schoolDirectoryRequest();
  let res: Response;
  try {
    res = await fetcher(req.url, { method: 'GET', headers: req.headers });
  } catch (e) {
    throw new UserError(e instanceof UserError ? e.message : '拉取学校列表失败，请检查网络连接。');
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new UserError('学校列表响应格式异常。');
  }
  if (!res.ok || Number(payload?.code) !== 200 || !Array.isArray(payload?.data)) {
    throw new UserError(`拉取学校列表未成功（HTTP ${res.status}）。`);
  }
  const out: SchoolDirectoryEntry[] = [];
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    const name = String(r.cnName ?? r.name ?? '').trim();
    const code = String(r.code ?? '').trim();
    const baseUrl = normalizeSchoolServerUrl(r.serverUrl, code);
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || !name || !baseUrl) continue;
    const nameEn = String(r.enName ?? '').trim() || code || name;
    const provinceCode = String(r.provinceCode ?? '').trim().slice(0, 16);
    const randomCode = String(r.randomCode ?? '').trim().slice(0, 16);
    const loginType = String(r.loginType ?? '').trim().slice(0, 8) || undefined;
    const loginUrl = typeof r.loginUrl === 'string' && r.loginUrl.trim() ? r.loginUrl.trim().slice(0, 300) : undefined;
    out.push({
      id,
      name: name.slice(0, 60),
      nameEn: nameEn.slice(0, 80),
      code: code.slice(0, 32),
      provinceCode,
      randomCode,
      baseUrl,
      ...(loginType ? { loginType } : {}),
      ...(loginUrl ? { loginUrl } : {}),
    });
  }
  if (!out.length) throw new UserError('学校列表为空。');
  return out;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i++;
      if (i === needle.length) return true;
    }
  }
  return i === needle.length;
}

export function searchSchools(list: readonly SchoolDirectoryEntry[], rawQuery: string): SchoolDirectoryEntry[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return [...list];
  const scored: Array<{ item: SchoolDirectoryEntry; score: number }> = [];
  for (const item of list) {
    const name = item.name.toLowerCase();
    const nameEn = item.nameEn.toLowerCase();
    const code = item.code.toLowerCase();
    const id = item.id.toLowerCase();
    let score = 0;
    if (name === q || code === q || id === q || nameEn === q) score = 100;
    else if (name.startsWith(q) || code.startsWith(q)) score = 80;
    else if (name.includes(q) || code.includes(q) || nameEn.includes(q)) score = 60;
    else if (q.length >= 2 && isSubsequence(q, name)) score = 40;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || Number(a.item.id) - Number(b.item.id));
  return scored.map(s => s.item);
}
