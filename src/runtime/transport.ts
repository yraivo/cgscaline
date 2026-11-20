import { Agent, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';
import { BASE, UPDATE_BASE, UserError } from '../core/model.js';

export function validateProxy(raw: string): string {
  if (!raw.trim()) return '';
  let u: URL; try { u = new URL(raw.trim()); } catch { throw new UserError('代理地址格式错误。'); }
  if (!['http:', 'https:', 'socks5:', 'socks:'].includes(u.protocol) || !u.hostname ||
    u.pathname !== '' && u.pathname !== '/' || u.search || u.hash) throw new UserError('代理仅支持 HTTP(S) / SOCKS5 地址。');
  return u.href;
}

/** 每账号独立 dispatcher；代理失败不会回落直连。不使用全局代理或关闭 TLS 校验。 */
export class Transport {
  private dispatcher?: Dispatcher;
  readonly fetch: typeof fetch;
  constructor(proxy: string, mock?: typeof fetch, extraAllowedBase?: string) {
    const url = validateProxy(proxy);
    const allowedOrigins = new Set([new URL(BASE).origin, new URL(UPDATE_BASE).origin]);
    if (extraAllowedBase) {
      try { allowedOrigins.add(new URL(extraAllowedBase).origin); } catch { /* ignore invalid extra base */ }
    }
    if (!mock) {
      this.dispatcher = !url ? new Agent() : /^socks/.test(url) ? new Socks5ProxyAgent(url) : new ProxyAgent(url);
    }
    this.fetch = (async (input, init = {}) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (!allowedOrigins.has(target.origin) ||
        target.username || target.password || target.hash) throw new UserError('请求目标不在服务白名单。');
      const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(init.signal ? [init.signal] : [])]);
      try {
        return await (mock ?? fetch)(target.href, { ...init, redirect: 'error', signal,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) } as RequestInit);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError('连接失败或超时。');
      }
    }) as typeof fetch;
  }
  async close() { await this.dispatcher?.close(); }
}
