import { BASE, UPDATE_BASE, UserError } from '../core/model.js';

export interface ProbeEvent { phase: string; method: string; endpoint: string; status?: number; code?: number; elapsedMs: number }

/** 单账号会话实验的外发白名单：公共检查、一次显式登录、两次只读查询。 */
export class ExperimentFence {
  phase: 'public' | 'login' | 'query' = 'public';
  readonly events: ProbeEvent[] = [];
  private logins = 0;
  private queries = 0;
  private versions = 0;
  constructor(private upstream: typeof fetch, private account: string, private imei: string) {}
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const isVersion = url.origin === new URL(UPDATE_BASE).origin && url.pathname === '/cgapp/api/version' && method === 'GET';
    const isLogin = url.origin === new URL(BASE).origin && url.pathname === '/cgapp-server/api/f/v6/login' && method === 'POST';
    const isQuery = url.origin === new URL(BASE).origin && url.pathname === '/cgapp-server/api/l/v7/sportlist' && method === 'GET';
    if (url.username || url.password || url.hash) throw new UserError('实验请求地址不合法。');
    if (isVersion) {
      if (['cgAuthorization','imei','client','Authorization','Cookie','SECRET'].some(h=>headers.has(h)) || ++this.versions > 4)
        throw new UserError('实验公共检查携带凭据或次数超限，已阻止。');
    } else if (isLogin) {
      const form = init?.body instanceof URLSearchParams ? init.body :
        typeof init?.body === 'string' ? new URLSearchParams(init.body) : undefined;
      if (!form) throw new UserError('实验登录表单格式不支持，已在本地阻止。');
      const username = form.get('username');
      if (this.phase !== 'login' || this.logins !== 0 || username !== this.account || headers.get('imei') !== this.imei)
        throw new UserError('实验只允许目标账号的一次显式登录，已阻止。');
      this.logins++;
    } else if (isQuery) {
      if (this.phase !== 'query' || this.queries >= 2 || url.searchParams.get('xh') !== this.account ||
        headers.get('imei') !== this.imei || !headers.get('cgAuthorization'))
        throw new UserError('实验只允许目标账号的两次只读查询，已阻止。');
      this.queries++;
    } else throw new UserError('本轮会话实验禁止续期、任务开始、sportId 申请和提交请求。');
    const started = Date.now(), event: ProbeEvent = { phase: this.phase, method, endpoint: url.pathname, elapsedMs: 0 };
    this.events.push(event);
    try {
      const response = await this.upstream(input, init); event.status = response.status;
      try { const json = await response.clone().json() as { code?: unknown }; if (typeof json.code === 'number') event.code = json.code; } catch { /* 不保存响应正文 */ }
      return response;
    } finally { event.elapsedMs = Date.now() - started; }
  };
}
