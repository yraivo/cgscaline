/**
 * 外发包留档层（第二阶段·重构版）。
 *
 * 目标：成功 / 失败 / 异常 **三条路径全部落盘**，且审计失败绝不拖垮业务请求。
 *
 * 结构：
 *   createAuditRecord(ctx) → 记录容器
 *   auditedRequest(impl, ctx, url, init) → 统一 try / catch / finally：
 *       const audit = createAuditRecord(ctx);
 *       try {
 *         audit.request = captureRequest(...);
 *         const resp = await impl(...);
 *         audit.response = captureResponse(resp);
 *         return resp;
 *       } catch (error) {
 *         audit.error = serializeError(error);
 *         throw error;
 *       } finally {
 *         await writeAuditRecord(audit);   // 任何路径都会执行
 *       }
 *
 * 落盘目录：%OUTBOUND_TRACE_DIR% ?? %TEMP%\opencode\outbound
 * 安全：token/cgAuthorization/authorization/cookie/secret/imei 只存脱敏长度标记；
 *       文件 0o600，7 天自动清理。
 */

import { createHash, randomUUID } from "node:crypto";
import {
  openSync,
  writeSync,
  closeSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TRACE_DIR =
  process.env.OUTBOUND_TRACE_DIR ?? join(process.env.TEMP ?? tmpdir(), "opencode", "outbound");

/** 敏感请求头名集合（值永不落盘，只记长度） */
const SENSITIVE_HEADER_NAMES = new Set([
  "cgauthorization",
  "authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "secret",
  "imei",
]);

export interface AuditContext {
  /** 端点标识（sportsId / prejudgment / savesports / sensorZipFile） */
  endpoint: string;
  /** 参与签名的路径（可为空：如 GET sportsId 无 query） */
  signPath?: string;
  /** 业务 sportId（prejudgment/savesports/sensor 阶段应已获取） */
  sportId?: string;
}

export interface AuditRecord {
  requestId: string;
  sentAt: number;
  endpoint: string;
  method: string;
  actualUrl: string;
  signPath?: string;
  sportId?: string;
  contentType?: string;
  bodySha256?: string;
  cipherSha256?: string;
  headersRedacted: Record<string, string>;
  responseAt?: number;
  status?: number;
  responseBodySha256?: string;
  responseBodyPreview?: string;
  error?: string;
}

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function createAuditRecord(ctx: AuditContext): AuditRecord {
  return {
    requestId: randomUUID(),
    sentAt: Date.now(),
    endpoint: ctx.endpoint,
    signPath: ctx.signPath,
    sportId: ctx.sportId,
    actualUrl: "",
    method: "",
    headersRedacted: {},
  };
}

function formatHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers == null) return out;
  const entries = (headers as { entries?: () => Iterable<[string, string]> }).entries;
  if (typeof entries === "function") {
    for (const [k, v] of entries.call(headers)) out[k] = formatHeaderValue(k, v);
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = formatHeaderValue(k, v);
    return out;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    out[k] = formatHeaderValue(k, v);
  }
  return out;
}

function formatHeaderValue(name: string, value: string): string {
  const lk = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(lk)
    ? `***REDACTED***(${Buffer.byteLength(value, "utf8")}B)`
    : value;
}

function bodyBytes(body: unknown): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof Buffer) return body;
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(body as unknown as ArrayBuffer);
  return Buffer.alloc(0);
}

/** 从 body 中提取 jsonsports 密文（form 表单 / query 均可能） */
function extractCipher(body: unknown, url: string): string {
  if (body instanceof URLSearchParams) {
    const c = body.get("jsonsports");
    if (c) return c;
  }
  if (typeof body === "string") {
    try {
      const c = new URLSearchParams(body).get("jsonsports");
      if (c) return c;
    } catch {
      /* 非表单字符串 */
    }
  }
  try {
    const q = new URL(url).searchParams.get("jsonsports");
    if (q) return q;
  } catch {
    /* 非法 URL */
  }
  return "";
}

/** 捕获请求侧信息（不抛错：任何解析失败都不影响主流程） */
export function captureRequest(
  audit: AuditRecord,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): void {
  try {
    audit.actualUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    audit.method = (init?.method ?? "GET").toUpperCase();
    audit.headersRedacted = formatHeaders(init?.headers ?? {});
    const ct = (init?.headers as Record<string, string> | undefined)?.["Content-Type"];
    if (ct) audit.contentType = ct;
    const bytes = bodyBytes(init?.body);
    audit.bodySha256 = bytes.length ? sha256Hex(bytes) : undefined;
    const cipher = extractCipher(init?.body, audit.actualUrl);
    if (cipher) audit.cipherSha256 = sha256Hex(cipher);
  } catch {
    /* capture 失败不阻断请求 */
  }
}

/** 捕获响应侧信息（只读 body 克隆，不消费原响应） */
export async function captureResponse(
  audit: AuditRecord,
  resp: Response,
): Promise<void> {
  try {
    audit.responseAt = Date.now();
    audit.status = resp.status;
    const text = await resp.clone().text();
    audit.responseBodySha256 = sha256Hex(text);
    audit.responseBodyPreview = text.length > 2000 ? `${text.slice(0, 2000)}…(truncated)` : text;
  } catch {
    /* 读不到 body 也照记 */
  }
}

export function serializeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function ensureDir(): void {
  if (!existsSync(TRACE_DIR)) mkdirSync(TRACE_DIR, { recursive: true });
}

function cleanupOld(now: number): void {
  try {
    ensureDir();
    const cutoff = now - 7 * 24 * 3600 * 1000;
    for (const f of readdirSync(TRACE_DIR)) {
      try {
        if (statSync(join(TRACE_DIR, f)).mtimeMs < cutoff) rmSync(join(TRACE_DIR, f), { force: true });
      } catch {
        /* 单个文件清理失败不阻断 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/**
 * 落盘（内部消化一切写盘错误：审计失败绝不拖垮业务请求）。
 * 返回文件路径；写盘失败返回 null 并 console.warn（可观测、不影响主流程）。
 */
export async function writeAuditRecord(audit: AuditRecord): Promise<string | null> {
  try {
    const lines = [
      `requestId=${audit.requestId}`,
      `sentAt=${audit.sentAt}`,
      `endpoint=${audit.endpoint}`,
      `sportId=${audit.sportId ?? ""}`,
      `METHOD : ${audit.method}`,
      `URL    : ${audit.actualUrl}`,
      `signPath: ${audit.signPath ?? ""}`,
      `contentType: ${audit.contentType ?? ""}`,
      `bodySha256: ${audit.bodySha256 ?? ""}`,
      `cipherSha256: ${audit.cipherSha256 ?? ""}`,
      "HEADERS: " + JSON.stringify(audit.headersRedacted, null, 2),
      `responseAt: ${audit.responseAt ?? ""}`,
      `status: ${audit.status ?? ""}`,
      `responseBodySha256: ${audit.responseBodySha256 ?? ""}`,
      `responseBodyPreview: ${audit.responseBodyPreview ?? ""}`,
      `error: ${audit.error ?? ""}`,
    ].join("\n");
    ensureDir();
    const file = join(TRACE_DIR, `${audit.sentAt}-${audit.requestId}.txt`);
    const fd = openSync(file, "w");
    try {
      writeSync(fd, lines, null, "utf8");
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows 下可能不支持 */
    }
    cleanupOld(audit.sentAt);
    return file;
  } catch (error) {
    console.warn(`[outbound-trace] 落盘失败（不影响请求）: ${serializeError(error)}`);
    return null;
  }
}

/**
 * 统一审计请求：成功 / 失败 / 异常 三条路径都在 finally 落盘。
 * 用法：在 full-submit 中把每个外发 fetch 替换为 auditedRequest(fetchImpl, ctx, url, init)。
 */
export async function auditedRequest(
  impl: typeof fetch,
  ctx: AuditContext,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const audit = createAuditRecord(ctx);
  try {
    captureRequest(audit, input, init);
    const resp = await impl(input, init);
    await captureResponse(audit, resp);
    return resp;
  } catch (error) {
    audit.error = serializeError(error);
    throw error;
  } finally {
    await writeAuditRecord(audit);
  }
}

/**
 * 兼容旧接口：全局包装 fetch（context 从 URL 推断 endpoint）。
 * 新代码请直接用 auditedRequest（可携带 signPath/sportId）。
 */
export function traceFetch(impl: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let url = "";
    try {
      url =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
    } catch {
      /* 忽略 */
    }
    let endpoint = "unknown";
    if (url.includes("/sportsId")) endpoint = "sportsId";
    else if (url.includes("/prejudgment")) endpoint = "prejudgment";
    else if (url.includes("/savesports")) endpoint = "savesports";
    else if (url.includes("/sensorZipFile")) endpoint = "sensorZipFile";
    return auditedRequest(impl, { endpoint }, input, init);
  }) as typeof fetch;
}
