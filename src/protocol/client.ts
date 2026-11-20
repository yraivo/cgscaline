/**
 * CgSportClient：上传协议客户端。
 *
 * 组装流程（对应 NativeToken_C0265 拦截器 + m3863 编码）：
 *   1. 取端点定义（method + path）
 *   2. 拼接完整 URL，用 extractSignPath 提取签名路径
 *   3. Signer.sign() → timestamp/sign header
 *   4. BodyEncoder.encode(json) → jsonsports 表单字段
 *   5. 注入固定 headers（imei/v1/client/cgAuthorization/User-Agent/app-key）
 *   6. POST 到 baseUrl + path
 *
 * 默认 transport 用 Node 原生 fetch。signer 与 encoder 均可插拔。
 */

import {
  appKeyNeeded,
  extractSignPath,
  type EndpointDef,
} from "./endpoint.js";
import type { BodyEncoder } from "./encoder.js";
import type { Signer } from "./signer.js";
import { buildV1 } from "./device.js";
import type {
  ApiResult,
  CgSportHeaders,
  PreparedRequest,
  SportResult,
} from "./types.js";

export interface ClientOptions {
  baseUrl: string;
  /** TOKEN（cgAuthorization） */
  token: string;
  imei: string;
  /** 客户端版本号 v1，如 "5.5.46" */
  version: string;
  /** client 字段，如 "android" */
  client: string;
  userAgent?: string;
  /** app-key 值（如已知）；缺省时占位 "[app-key]" 并标记 needed */
  appKey?: string;
  /** 额外请求头（如用于控制 mock server 行为的 x-mock-mode） */
  extraHeaders?: Record<string, string>;
  /** 注入 fetch（测试用）；缺省用全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface UploadResult {
  /** HTTP 层：code==200 且 ApiResult.code==200 */
  ok: boolean;
  api: ApiResult<SportResult>;
  prepared: PreparedRequest;
  /** 业务有效判定：ApiResult.code==200 且 data 存在且 isValid=="1" */
  businessValid: boolean;
}

export class CgSportClient {
  readonly baseUrl: string;

  constructor(
    private readonly signer: Signer,
    private readonly encoder: BodyEncoder,
    private readonly options: ClientOptions,
  ) {
    this.baseUrl = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
  }

  /** 构造请求（不发送）——便于测试与抓包对照 */
  async prepare(
    endpoint: EndpointDef,
    jsonBody: string,
  ): Promise<PreparedRequest> {
    const url = `${this.baseUrl}${endpoint.path}`;
    const signPath = extractSignPath(url);
    const { timestamp, sign } = await this.signer.sign({
      method: endpoint.method,
      signPath,
      body: jsonBody,
    });

    const jsonsports = await this.encoder.encode(jsonBody);

    const headers: CgSportHeaders = {
      "Content-Type": "application/x-www-form-urlencoded",
      imei: this.options.imei,
      // v1 每次请求动态 = MD5(now_ms)（App 无缓存时行为；显式 version 时用显式值）
      v1: this.options.version || buildV1(),
      timestamp,
      sign,
      cgAuthorization: this.options.token,
      "User-Agent":
        this.options.userAgent ?? "CgSport/5.5.46 (Android; cgsport)",
      client: this.options.client,
    };
    if (appKeyNeeded(this.baseUrl)) {
      headers["app-key"] = this.options.appKey ?? "[app-key]";
    }
    for (const [key, value] of Object.entries(
      this.options.extraHeaders ?? {},
    )) {
      headers[key as keyof CgSportHeaders] = value;
    }

    // fetch 的 HeadersInit 需要 index signature，转成普通 Record
    const fetchHeaders: Record<string, string> = { ...headers };

    return {
      method: endpoint.method,
      url,
      headers,
      jsonBody,
      jsonsports,
      fetchHeaders,
    };
  }

  /** 执行上传并返回结构化结果 */
  async upload(endpoint: EndpointDef, jsonBody: string): Promise<UploadResult> {
    const prepared = await this.prepare(endpoint, jsonBody);
    const body = new URLSearchParams({ jsonsports: prepared.jsonsports });

    const response = await (this.options.fetchImpl ?? fetch)(prepared.url, {
      method: prepared.method,
      headers: prepared.fetchHeaders,
      body: endpoint.method === "POST" ? body : undefined,
    });

    const api = (await response.json()) as ApiResult<SportResult>;
    const ok = response.ok && api.code === 200;
    const businessValid =
      ok && api.data !== null && api.data.isValid === "1";
    return { ok, api, prepared, businessValid };
  }
}
