/**
 * 提交处理器（纯逻辑，可注入 fetch / 白名单 —— 便于行为测试与安全审计）。
 *
 * /api/submit 路由只是本模块的薄包装（见 final/viewer/app/api/submit/route.ts）。
 *
 * 安全设计：
 *  - mode="preview"：只构造请求，**绝不外发**；mode="submit" 才真实发送。
 *  - baseUrl 白名单：默认仅 loopback mock（localhost:8787），真实目标必须由
 *    调用方显式传 allowedOrigins（如环境变量 CGSPORT_REAL_BASE_URL），防 SSRF。
 *  - 返回的 headers 一律脱敏（cgAuthorization/SECRET/imei/cookie → ***REDACTED***）。
 */

import { CgSportClient } from "./client.js";
import { MockSigner, NativeSigner, ReplaySigner, type Signer } from "./signer.js";
import { NativeEncoder, PassthroughEncoder, type BodyEncoder } from "./encoder.js";
import { saveSports } from "./endpoint.js";

export interface SubmitConfig {
  baseUrl: string;
  token: string;
  imei: string;
  version: string;
  client: string;
  signer: "mock" | "replay" | "native";
  replayEntries?: Array<{ method: string; signPath: string; timestamp: string; sign: string }>;
  extraHeaders?: Record<string, string>;
  secret?: string;
  /** User-Agent 覆盖（默认 CgSport/5.5.46 (Android; cgsport)） */
  userAgent?: string;
}

export interface SubmitInput {
  body: unknown;
  config: SubmitConfig;
  mode?: "preview" | "submit";
}

export interface SubmitOutcome {
  ok: true;
  mode: "preview" | "submit";
  code: number;
  message: string;
  data: {
    sportId: string;
    isValid: string;
    inValidReason: string;
    checkStatus: string;
    tip: string;
  } | null;
  prepared: {
    url: string;
    headers: Record<string, string>;
    jsonsportsPreview: string;
  };
}

export interface SubmitError {
  ok: false;
  error: string;
  status: number;
}

export type SubmitResult = SubmitOutcome | SubmitError;

/** 默认白名单：loopback mock server（SSRF 防线） */
export const DEFAULT_ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://[::1]:8787",
]);

/** 敏感请求头：回传时一律脱敏（键统一转小写匹配） */
export const SENSITIVE_HEADERS = new Set([
  "cgauthorization",
  "authorization",
  "secret",
  "imei",
  "cookie",
  "set-cookie",
  "x-auth-token",
]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "***REDACTED***" : v;
  }
  return out;
}

export function isAllowedBaseUrl(
  raw: string,
  allowed: Set<string> = DEFAULT_ALLOWED_ORIGINS,
): boolean {
  try {
    return allowed.has(new URL(raw).origin);
  } catch {
    return false;
  }
}

export interface SubmitHandlerOptions {
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 允许的目标 origin（默认 loopback mock 白名单） */
  allowedOrigins?: Set<string>;
}

function buildSigner(config: SubmitConfig): Signer {
  if (config.signer === "replay") {
    return new ReplaySigner(config.replayEntries ?? []);
  }
  if (config.signer === "native") {
    if (!config.secret) {
      throw new Error("native 签名需要 config.secret（登录 token 第 4 段）");
    }
    return new NativeSigner({ secret: config.secret });
  }
  return new MockSigner();
}

export async function handleSubmit(
  input: SubmitInput,
  opts: SubmitHandlerOptions = {},
): Promise<SubmitResult> {
  const mode: "preview" | "submit" = input.mode ?? "preview";
  const { body, config } = input;

  if (!body || typeof body !== "object") {
    return { ok: false, error: "缺少 body（UploadJsonSports）", status: 400 };
  }
  if (!config?.baseUrl) {
    return { ok: false, error: "缺少 config.baseUrl", status: 400 };
  }
  // SSRF 防线：baseUrl 必须落在白名单
  if (!isAllowedBaseUrl(config.baseUrl, opts.allowedOrigins)) {
    return {
      ok: false,
      error: `baseUrl 不在白名单（默认仅 localhost:8787；真实目标需显式配置）：${config.baseUrl}`,
      status: 400,
    };
  }

  let signer: Signer;
  try {
    signer = buildSigner(config);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: 400,
    };
  }

  const encoder: BodyEncoder = config.secret
    ? new NativeEncoder(config.secret)
    : new PassthroughEncoder();
  const client = new CgSportClient(signer, encoder, {
    baseUrl: config.baseUrl,
    token: config.token,
    imei: config.imei,
    version: config.version,
    client: config.client,
    extraHeaders: config.extraHeaders,
    userAgent: config.userAgent,
    fetchImpl: opts.fetchImpl,
  });

  const jsonBody = JSON.stringify(body);

  // 构造（不发送）——签名/编码错误在此暴露
  let prepared;
  try {
    prepared = await client.prepare(saveSports, jsonBody);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: 400,
    };
  }

  // preview：到此为止，绝不外发
  if (mode === "preview") {
    return {
      ok: true,
      mode,
      code: 0,
      message: "（preview 模式，未发送）",
      data: null,
      prepared: {
        url: prepared.url,
        headers: redactHeaders(prepared.fetchHeaders),
        jsonsportsPreview: prepared.jsonsports.slice(0, 200),
      },
    };
  }

  // submit：真实发送
  let upload;
  try {
    upload = await client.upload(saveSports, jsonBody);
  } catch (error) {
    return {
      ok: false,
      error: `出站请求失败：${error instanceof Error ? error.message : String(error)}`,
      status: 502,
    };
  }

  return {
    ok: true,
    mode,
    code: upload.api.code,
    message: upload.api.message,
    data: upload.api.data
      ? {
          sportId: upload.api.data.sportId,
          isValid: upload.api.data.isValid,
          inValidReason: upload.api.data.inValidReason,
          checkStatus: upload.api.data.checkStatus,
          tip: upload.api.data.tip,
        }
      : null,
    prepared: {
      url: prepared.url,
      headers: redactHeaders(prepared.fetchHeaders),
      jsonsportsPreview: prepared.jsonsports.slice(0, 200),
    },
  };
}
