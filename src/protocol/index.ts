import { randomUUID } from 'node:crypto';
import { login, buildClient } from './login.js';
import { NativeSigner } from './signer.js';
import { buildV1 } from './device.js';
import { fetchRecords, type WorkoutRecord } from './records.js';
import { compatibilityKey, deviceHeaders, identity, UserError, type Account, type Compatibility, type RecordScope, type Session } from '../core/model.js';
import { publicVersionRequest } from '../campus/public-version.js';

const CHECK_TTL = 6 * 3600_000;
export function parseVersion(data: unknown, message?: unknown): Pick<Compatibility, 'status' | 'note'> {
  if (data === '' && message === '未发现新版本')
    return { status: 'ok', note: '未发现更新' };
  if (typeof data === 'string' && /最新|无需更新|无更新|up.to.date|latest/i.test(data) && !/发现|有新|not|不是|非最新/i.test(data))
    return { status: 'ok', note: '未发现更新' };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if ((d.isForceUpdate === 0 || d.isForceUpdate === 1) && typeof d.content === 'string')
      return { status: 'update', note: d.isForceUpdate === 1 ? '需要更新客户端' : '发现新版本，需要更新' };
  }
  return { status: 'unknown', note: '无法识别更新信息' };
}

export class Protocol {
  constructor(readonly fetch: typeof globalThis.fetch) {}
  async check(a: Account): Promise<Compatibility> {
    const common = { checkedAt: Date.now(), key: compatibilityKey(a) };
    if (!a.school.id) return { ...common, status: 'unknown', note: '请填写学校 ID' };
    if (a.device.appVersion !== '3.0.0') return { ...common, status: 'unknown', note: '暂不支持此 App 版本' };
    try {
      // 公共版本探测不附带密码、TOKEN、SECRET，也不转发业务设备/代理认证头。
      const request = publicVersionRequest(a.device.appVersion, a.school.id);
      const response = await this.fetch(request.url, { headers: request.headers });
      const api = await response.json() as { code?: number; data?: unknown; message?: unknown };
      if (!response.ok || api.code !== 200) return { ...common, status: 'unknown', note: '更新检查失败' };
      return { ...common, ...parseVersion(api.data, api.message) };
    } catch { return { ...common, status: 'unknown', note: '更新检查连接失败' }; }
  }
  async ensure(a: Account): Promise<void> {
    const c = a.compatibility;
    if (!c || c.key !== compatibilityKey(a) || Date.now() < c.checkedAt || Date.now() - c.checkedAt >= CHECK_TTL || c.status !== 'ok')
      a.compatibility = await this.check(a);
    if (a.compatibility?.status !== 'ok') throw new UserError(a.compatibility?.note ?? '请先检查更新。');
  }
  async login(a: Account, password: string): Promise<Session> {
    await this.ensure(a);
    const r = await login(a.username, password, { baseUrl: a.school.baseUrl, school: a.school,
      version: a.device.appVersion, userAgent: deviceHeaders(a.device).userAgent,
      imei: deviceHeaders(a.device).imei, fetchImpl: this.fetch });
    if (!r.ok) throw new UserError(`登录未成功（HTTP ${r.httpStatus ?? '未知'}，业务码 ${Number(r.code) || '未知'}）。`);
    if (!r.token || !r.secret || Buffer.from(r.secret, 'base64').length < 52) throw new UserError('登录信息格式异常。');
    const xh = String(r.userInfo?.xh ?? a.username);
    if (xh !== a.username) throw new UserError('登录返回的账号不匹配。');
    return { id: randomUUID(), token: r.token, secret: r.secret, loginOutTime: r.loginOutTime,
      xh, name: String(r.userInfo?.xm ?? ''), gender: String(r.userInfo?.xb ?? '1'),
      identity: identity(a), createdAt: Date.now(), status: 'verified' };
  }
  session(a: Account): Session {
    if (!a.session || a.session.status === 'invalid' || a.session.identity !== identity(a) || a.session.xh !== a.username)
      throw new UserError('登录信息已失效，请重新登录。');
    return a.session;
  }
  async renew(a: Account): Promise<void> {
    await this.ensure(a);
    const s = this.session(a), path = '/api/l/v6/issue';
    const sig = await new NativeSigner({ secret: s.secret }).sign({ method: 'POST', signPath: path });
    const response = await this.fetch(a.school.baseUrl + path.slice(1), { method: 'POST', headers: {
      imei: deviceHeaders(a.device).imei, 'User-Agent': deviceHeaders(a.device).userAgent, v1: buildV1(),
      client: buildClient(s.secret), cgAuthorization: s.token, timestamp: sig.timestamp, sign: sig.sign,
    } });
    const api = await response.json() as { code: number; data?: string };
    if (api.code === 2001) s.status = 'invalid';
    if (!response.ok || api.code !== 200 || typeof api.data !== 'string') throw new UserError('登录续期失败。');
    const p = api.data.split('.');
    if (p.length !== 5 || p.some(v => !v) || Buffer.from(p[3]!, 'base64').length < 52) throw new UserError('登录续期信息格式异常。');
    // 同一个本地会话代次；任务引用无需转向另一个账号或新密码登录。
    s.token = p.slice(0, 3).join('.'); s.secret = p[3]!; s.loginOutTime = p[4]!; s.status = 'verified';
  }
  async records(a: Account, persist: () => Promise<void>, scope: RecordScope = 'current'): Promise<WorkoutRecord[]> {
    await this.ensure(a);
    const type = scope === 'archive' ? '0' : '1';
    const run = () => fetchRecords({ ...this.session(a), baseUrl: a.school.baseUrl, type,
      session: deviceHeaders(a.device), fetchImpl: this.fetch });
    let r = await run();
    if (r.code === 2003) { await this.renew(a); await persist(); r = await run(); }
    if (r.code === 2001 && a.session) a.session.status = 'invalid';
    if (!r.ok) throw new UserError(`查询未成功（HTTP ${r.httpStatus ?? '未知'}，业务码 ${r.code ?? '未知'}）。`);
    this.session(a).status = 'verified';
    return r.records;
  }
}
