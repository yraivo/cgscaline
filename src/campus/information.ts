import { NativeSigner } from '../protocol/signer.js';
import { buildClient } from '../protocol/login.js';
import { buildV1 } from '../protocol/device.js';
import { parseBoundaryString } from './android-import.js';
import type { GcjCoord } from '../track/types.js';
import { deviceHeaders, identity, safeText, UserError, type Account } from '../core/model.js';
import { extractMinimapFromDetail, type MinimapPoint } from '../render/minimap.js';

export interface ReadResult<T> { data?: T; error?: string; code?: number }
export interface Term { id: string; name: string; start: string; end: string; current: boolean }
export interface Statistics { count: number; monthlyDistance: string; monthlyTime: string; monthlyCount: number; distances: number[] }
export interface Total { label: string; value: string; unit: string }
export interface SportRule {
  id: string; name: string; distanceKm?: number; minDuration: string; maxDuration: string;
  sensor?: boolean; randomPoints?: boolean; validCount?: number; tips: string;
  boundaryGcj02?: GcjCoord[];
  faceAuth?: boolean;
  dynamicWaypoints?: boolean;
  requiredCheckpoints?: number;
}
export interface InvalidReason { code: string; reason: string; description: string }
export interface SchoolNotice {
  id: string;
  title: string;
  date?: string;
  remindWindow?: string;
  forced?: boolean;
  summary?: string;
  url?: string;
  body?: string[];
  source: 'banner' | 'marquee';
}
export interface AccountInformation {
  identity: string; sessionId: string; fetchedAt: number;
  schoolFetchedAt?: number;
  noticesFetchedAt?: number;
  clock: ReadResult<{ serverMs: number; offsetMs: number; rttMs: number }>;
  terms: ReadResult<Term[]>; totals: ReadResult<Total[]>;
  statistics: ReadResult<Statistics>; rules: ReadResult<SportRule[]>; reasons: ReadResult<InvalidReason[]>;
  notices?: ReadResult<SchoolNotice[]>;
}
export interface RecordReference { sportId: string; tableName?: string }
export interface RecordDetail {
  fetchedAt: number; coordinateCount?: number; routeCount?: number; minuteCount?: number;
  sensorReturned: boolean; fields: string[]; minimap?: MinimapPoint[];
}
const paths = {
  clock: 'api/l/v6/currentTimeMillis', terms: 'api/l/v6/termlist', totals: 'api/l/v6/termSportTotal',
  statistics: 'api/l/v6/statistics', rules: 'api/l/v6/sporttype', reasons: 'api/l/v6.1/sports/invalidconf',
  detail: 'api/l/v7/sport/detail', activity: 'api/l/v6/activity', notifications: 'api/l/v6/notifications',
} as const;
export type InformationKind = keyof typeof paths;
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new UserError('响应结构未识别。');
  return v as Record<string, unknown>;
};
const array = (v: unknown) => { if (!Array.isArray(v)) throw new UserError('响应不是列表。'); return v; };
const text = (v: unknown, max = 240) => typeof v === 'string' || typeof v === 'number' ? safeText(v, max) : '';
const number = (v: unknown) => (typeof v==='number'||typeof v==='string'&&v.trim()!=='')&&Number.isFinite(Number(v)) ? Number(v) : undefined;
const flag = (v: unknown) => v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : undefined;
export function chinaDateMs(v: string): number {
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(v)) throw new UserError('学期日期格式未识别。');
  const ms = Date.parse(v.replace(' ', 'T') + (v.length === 10 ? 'T00:00:00' : '') + '+08:00');
  if (!Number.isFinite(ms)) throw new UserError('学期日期无效。'); return ms;
}
class ReadFailure extends UserError {
  constructor(message: string, readonly code: number | undefined, readonly stop: boolean) { super(message); }
}

export async function readInformationEndpoint(
  a: Account, fetcher: typeof fetch, kind: InformationKind,
  extra: { term?: Term; record?: RecordReference } = {},
): Promise<unknown> {
  if (!Object.hasOwn(paths, kind)) throw new UserError('不支持的信息读取项。');
  const s = a.session;
  if (!s || s.status === 'invalid' || s.identity !== identity(a) || s.xh !== a.username)
    throw new UserError('登录信息已失效，请重新登录。');
  const query = new URLSearchParams();
  if (kind === 'totals' || kind === 'statistics') query.set('xh', s.xh);
  if (kind === 'statistics') {
    if (!extra.term?.start || !extra.term.end) throw new UserError('缺少当前学期时间范围。');
    const start = chinaDateMs(extra.term.start.slice(0, 10) + ' 00:00:00');
    const end = chinaDateMs(extra.term.end.slice(0, 10) + ' 23:59:59');
    if (end < start) throw new UserError('当前学期日期范围异常。');
    query.set('beginTime', String(start)); query.set('endTime', String(end));
    query.set('validStatus', '1'); query.set('type', 'TERM');
  }
  if (kind === 'rules') query.set('uid', s.xh);
  if (kind === 'activity') query.set('page', '-1');
  if (kind === 'notifications') { query.set('page', '-1'); query.set('size', '-1'); }
  if (kind === 'detail') {
    if (!extra.record?.sportId || !/^[a-zA-Z0-9_-]{4,80}$/.test(extra.record.sportId)) throw new UserError('运动记录标识无效。');
    if (!extra.record.tableName || !/^[a-zA-Z0-9_]{4,32}$/.test(extra.record.tableName))
      throw new UserError('该记录缺少学期表信息，无法安全读取详情。');
    query.set('term', extra.record.tableName); query.set('sportId', extra.record.sportId);
  }
  const path = paths[kind] + (query.size ? `?${query.toString()}` : '');
  const sig = await new NativeSigner({ secret: s.secret }).sign({ method: 'GET', signPath: `/${path}` });
  const d = deviceHeaders(a.device);
  let response: Response;
  try {
    response = await fetcher(a.school.baseUrl + path, {
      method: 'GET',
      headers: {
        imei: d.imei,
        'User-Agent': d.userAgent,
        v1: buildV1(),
        client: buildClient(s.secret),
        cgAuthorization: s.token,
        timestamp: sig.timestamp,
        sign: sig.sign,
      },
    });
  } catch (e) {
    throw new ReadFailure(
      e instanceof UserError ? safeText(e.message) : '连接失败；信息读取已停止。',
      undefined,
      true,
    );
  }
  let api: Record<string, unknown>;
  try {
    api = object(await response.json());
  } catch {
    throw new ReadFailure('响应格式未识别；信息读取已停止。', undefined, true);
  }
  const code = number(api.code);
  if (code === 2001) s.status = 'invalid';
  if (!response.ok || code !== 200) throw new ReadFailure(code === 2001 ? '会话已失效。' : code === 2003 ? '会话需要续期；信息查询已停止。' : `读取未成功（HTTP ${response.status}，业务码 ${code ?? '未知'}）。`, code,
    code === 2001 || code === 2003 || [401, 403, 429].includes(response.status) || response.status >= 500);
  return api.data;
}

export async function fetchInformation(a: Account, fetcher: typeof fetch, scope: 'account' | 'school' = 'account'): Promise<AccountInformation> {
  const previous = a.information?.identity === identity(a) && a.information.sessionId === a.session?.id ? a.information : undefined;
  const missing: ReadResult<never> = { error: '尚未读取。' }, account = scope === 'account';
  let stopped = false, successfulReads = 0;
  const read = async <T>(kind: InformationKind, parse: (v: unknown) => T, term?: Term): Promise<ReadResult<T>> => {
    if (stopped) return { error: '读取已停止，未继续请求。' };
    try { const data = parse(await readInformationEndpoint(a, fetcher, kind, { term })); successfulReads++; return { data }; }
    catch (e) { if (e instanceof ReadFailure && e.stop) stopped = true;
      return { error: e instanceof UserError ? safeText(e.message) : '读取失败。', code: e instanceof ReadFailure ? e.code : undefined }; }
  };
  const before = Date.now();
  const clock = account ? await read('clock', v => { const serverMs = number(v); if (!serverMs || serverMs < 1e12 || serverMs > 1e14) throw new UserError('服务器时间格式未识别。');
    const after = Date.now(); return { serverMs, offsetMs: serverMs - (before + after) / 2, rttMs: after - before }; }) : previous?.clock ?? missing;
  const terms = account ? await read('terms', v => array(v).slice(0, 100).map(x => { const t = object(x); return { id: text(t.id ?? t._id), name: text(t.name), start: text(t.stadate), end: text(t.enddate), current: flag(t.isCurrentTerm) === true }; })) : previous?.terms ?? missing;
  const totals = account ? await read('totals', v => array(object(v).datas).slice(0, 30).map(x => { const t = object(x); return { label: text(t.des), value: text(t.value), unit: text(t.unit) }; })) : previous?.totals ?? missing;
  const current = terms.data?.find(t => t.current);
  const statistics = !account ? previous?.statistics ?? missing : current ? await read('statistics', v => { const d = object(v), count = number(d.totalExerciseCount); if (count === undefined) throw new UserError('统计字段未识别。');
    return { count, monthlyDistance: text(d.avgOdometer), monthlyTime: text(d.avgExerciseTime), monthlyCount: number(d.avgExerciseCount) ?? 0,
      distances: array(d.countArr).slice(0, 100).map(number).filter((n): n is number => n !== undefined) }; }, current) : { error: '未取得当前学期，统计未请求。' };
  const rules = account ? previous?.rules ?? missing : await read('rules', v => array(v).slice(0, 100).map(x => {
    const r = object(x);
    const boundaryGcj02 = parseBoundaryString(r.latlng);
    const startFace = flag(r.openStartPointFace) === true && flag(r.isSkipStartPointFace) !== true;
    const endFace = flag(r.openEndPointFace) === true && flag(r.isSkipEndPointFace) !== true;
    const faceAuth = startFace || endFace || (number(r.authType) ?? 0) > 0;
    const dynamicWaypoints = number(r.isRandomWayPoint) === 2;
    const requiredCheckpoints = Array.isArray(r.pointConfigList)
      ? r.pointConfigList.filter(p => p && typeof p === 'object' && flag((p as Record<string, unknown>).isneedgo ?? (p as Record<string, unknown>).isNeedGo) === true).length
      : 0;
    return {
      id: text(r.id), name: text(r.sportName), distanceKm: number(r.vdistance),
      minDuration: text(r.minVtime), maxDuration: text(r.maxVtime),
      sensor: flag(r.isUseSensor), randomPoints: flag(r.isRandomWayPoint),
      validCount: number(r.vcount), tips: text(r.tips),
      ...(boundaryGcj02 ? { boundaryGcj02 } : {}),
      ...(faceAuth ? { faceAuth: true } : {}),
      ...(dynamicWaypoints ? { dynamicWaypoints: true } : {}),
      ...(requiredCheckpoints > 0 ? { requiredCheckpoints } : {}),
    };
  }));
  const reasons = account ? previous?.reasons ?? missing : await read('reasons', v => array(v).slice(0, 100).map(x => { const r = object(x); return { code: text(r.code), reason: text(r.reason), description: text(r.reasonDes, 600) }; }));
  if (a.session && a.session.status !== 'invalid' && !stopped && successfulReads > 0) a.session.status = 'verified';
  return {
    identity: identity(a),
    sessionId: a.session?.id ?? '',
    fetchedAt: account ? Date.now() : previous?.fetchedAt ?? 0,
    schoolFetchedAt: account ? previous?.schoolFetchedAt : Date.now(),
    ...(previous?.notices ? { noticesFetchedAt: previous.noticesFetchedAt, notices: previous.notices } : {}),
    clock,
    terms,
    totals,
    statistics,
    rules,
    reasons,
  };
}

export function htmlToParagraphs(html: string): string[] {
  const withoutScripts = html
    .replace(/<(script|style|head|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = withoutScripts
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ldquo;|&#8220;/gi, '“')
    .replace(/&rdquo;|&#8221;/gi, '”')
    .replace(/&lsquo;|&#8216;/gi, '‘')
    .replace(/&rsquo;|&#8217;/gi, '’')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) && n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
    });
  return decoded
    .split(/\r?\n/)
    .map(line => safeText(line.replace(/\s+/g, ' ').trim(), 600))
    .filter(Boolean)
    .slice(0, 120);
}

export async function fetchSchoolNotices(a: Account, fetcher: typeof fetch): Promise<AccountInformation> {
  const previous = a.information?.identity === identity(a) && a.information.sessionId === a.session?.id ? a.information : undefined;
  const missing: ReadResult<never> = { error: '尚未读取。' };
  let stopped = false;
  let lastError: string | undefined;
  let lastCode: number | undefined;
  let okCount = 0;

  const readList = async (kind: 'activity' | 'notifications'): Promise<unknown[]> => {
    if (stopped) return [];
    try {
      const raw = await readInformationEndpoint(a, fetcher, kind);
      okCount++;
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).list)) {
        return (raw as Record<string, unknown>).list as unknown[];
      }
      if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).records)) {
        return (raw as Record<string, unknown>).records as unknown[];
      }
      return [];
    } catch (e) {
      if (e instanceof ReadFailure && e.stop) stopped = true;
      lastError = e instanceof UserError ? safeText(e.message) : '通知读取失败。';
      if (e instanceof ReadFailure && e.code !== undefined) lastCode = e.code;
      return [];
    }
  };

  const banners = await readList('activity');
  const marquees = await readList('notifications');

  const merged: SchoolNotice[] = [];
  const seen = new Set<string>();
  const oldBodies = new Map<string, string[]>();
  for (const old of previous?.notices?.data ?? []) {
    if (old.body?.length) oldBodies.set(old.id, old.body);
  }

  for (let i = 0; i < Math.min(60, banners.length); i++) {
    const raw = banners[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;
    const title = text(b.title, 200).trim();
    if (!title) continue;
    const url = text(b.url, 400).trim() || undefined;
    const orderPart = text(b.orderid ?? b.orderId ?? b.id, 40);
    const id = `banner:${orderPart || i}:${title.slice(0, 32)}`;
    const dedupKey = `${title}|${url ?? ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const start = text(b.remindStartTime ?? b.remindstarttime, 40).trim();
    const end = text(b.remindEndTime ?? b.remindendtime, 40).trim();
    const remindWindow = start || end ? `${start || '—'} ~ ${end || '—'}` : undefined;
    const date = text(b.createDate ?? b.createdate, 40).trim() || undefined;
    const summary = text(b.subContent ?? b.subcontent, 500).trim() || undefined;
    const forced = flag(b.isForcedRemind ?? b.isforcedremind) === true;
    const oldBody = oldBodies.get(id);
    merged.push({
      id,
      title,
      ...(date ? { date } : {}),
      ...(remindWindow ? { remindWindow } : {}),
      ...(forced ? { forced: true } : {}),
      ...(summary ? { summary } : {}),
      ...(url ? { url } : {}),
      ...(oldBody ? { body: oldBody } : {}),
      source: 'banner',
    });
  }

  for (let i = 0; i < Math.min(60, marquees.length); i++) {
    const raw = marquees[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const m = raw as Record<string, unknown>;
    const title = text(m.title ?? m.content, 200).trim();
    if (!title) continue;
    const url = text(m.url, 400).trim() || undefined;
    const dedupKey = `${title}|${url ?? ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const id = `notice:${text(m.id, 40) || i}:${title.slice(0, 32)}`;
    const date = text(m.createDate ?? m.createdate ?? m.publishTime, 40).trim() || undefined;
    const summary = text(m.subContent ?? m.content, 500).trim();
    const oldBody = oldBodies.get(id);
    merged.push({
      id,
      title,
      ...(date ? { date } : {}),
      ...(summary && summary !== title ? { summary } : {}),
      ...(url ? { url } : {}),
      ...(oldBody ? { body: oldBody } : {}),
      source: 'marquee',
    });
  }

  merged.sort((x, y) => {
    if (!!x.forced !== !!y.forced) return x.forced ? -1 : 1;
    return (y.date ?? '').localeCompare(x.date ?? '');
  });

  if (a.session && a.session.status !== 'invalid' && !stopped && okCount > 0) a.session.status = 'verified';

  const notices: ReadResult<SchoolNotice[]> =
    okCount > 0
      ? { data: merged }
      : { error: lastError ?? '未能获取学校通知。', ...(lastCode !== undefined ? { code: lastCode } : {}) };

  return {
    identity: identity(a),
    sessionId: a.session?.id ?? '',
    fetchedAt: previous?.fetchedAt ?? 0,
    ...(previous?.schoolFetchedAt ? { schoolFetchedAt: previous.schoolFetchedAt } : {}),
    noticesFetchedAt: Date.now(),
    clock: previous?.clock ?? missing,
    terms: previous?.terms ?? missing,
    totals: previous?.totals ?? missing,
    statistics: previous?.statistics ?? missing,
    rules: previous?.rules ?? missing,
    reasons: previous?.reasons ?? missing,
    notices,
  };
}

export async function fetchNoticeArticle(a: Account, fetcher: typeof fetch, rawUrl: string): Promise<string[] | undefined> {
  const s = a.session;
  if (!s || s.status === 'invalid' || s.identity !== identity(a) || s.xh !== a.username)
    throw new UserError('登录信息已失效，请重新登录。');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  const baseOrigin = new URL(a.school.baseUrl);
  // 仅对同源 CGSport 服务端通知详情页附带鉴权头拉取正文；外部站点链接只展示原链接不透传凭据
  if (parsed.hostname !== baseOrigin.hostname || !/^\/cgapp-server\/activity\/detail\/[\w-]+$/.test(parsed.pathname)) {
    return undefined;
  }
  const safeUrl = `${baseOrigin.protocol}//${baseOrigin.host}${parsed.pathname}`;
  const d = deviceHeaders(a.device);
  const res = await fetcher(safeUrl, {
    method: 'GET',
    headers: {
      imei: d.imei,
      'User-Agent': d.userAgent,
      cgAuthorization: s.token,
    },
  });
  if (!res.ok) return undefined;
  const html = await res.text();
  const paragraphs = htmlToParagraphs(html);
  return paragraphs.length ? paragraphs : undefined;
}
function countItems(v: unknown): number | undefined {
  if (Array.isArray(v)) return v.length; if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'string') { try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.length : undefined; } catch { return undefined; } }
  return undefined;
}
export async function fetchRecordDetail(a: Account, fetcher: typeof fetch, record: RecordReference): Promise<RecordDetail> {
  const data = object(await readInformationEndpoint(a, fetcher, 'detail', { record }));
  const minimap = extractMinimapFromDetail(data);
  return {
    fetchedAt: Date.now(),
    coordinateCount: countItems(data.coordinatestr ?? data.coordinate),
    routeCount: countItems(data.routepolylinelist),
    minuteCount: countItems(data.minuteSpeedStr ?? data.minuteSpeed),
    sensorReturned: typeof data.sensorFile === 'string' && data.sensorFile.length > 0,
    fields: Object.keys(data).filter(k => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)).slice(0, 100),
    ...(minimap ? { minimap } : {}),
  };
}
