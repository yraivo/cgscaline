/**
 * 完整 3 步提交（sportId → savesports → sensorZipFile）—— 服务端实测全部 200 的链路。
 *
 * 已确证（2026-08-01，SSL 抓包 + 服务端响应）：
 *   1. GET  /api/l/v7/sportsId                      → 签名（无 query）
 *   2. POST /api/l/v7/savesports                    → ★签名路径含 `?jsonsports=<密文>`（+ URL 解码）
 *   3. POST /api/l/v7/upload/sensorZipFile?sportId=..&sensorZipFile=..txt  → ★签名路径含 query
 *
 * 会话级头（imei/v1/client/UA）来自抓包，同一登录会话内恒定；换登录需重新抓取。
 * 安全：mode="preview" 只构造绝不外发；baseUrl 白名单防 SSRF；返回头一律脱敏。
 *
 * 本模块从 direct-submit.ts 提炼，支持注入 fetch 与白名单，便于单测与 viewer 路由复用。
 */

import { gzipSync } from "node:zlib";
import { NativeSigner, MockSigner, ReplaySigner, type Signer } from "./signer.js";
import { NativeEncoder, PassthroughEncoder, type BodyEncoder } from "./encoder.js";
import { sportsId, saveSports, uploadSensorZip, prejudgment } from "./endpoint.js";
import { androidIdToImei, buildUserAgent, buildV1 } from "./device.js";
import { buildPrejudgmentSnapshot, assertSnapshotInvariants } from "./prejudgment.js";
import { auditedRequest } from "./outbound-trace.js";
import {
  isAllowedBaseUrl,
  DEFAULT_ALLOWED_ORIGINS,
  redactHeaders,
  type SubmitConfig,
} from "./submit-handler.js";
import { sensorToText } from "./sensor.js";
import { buildClient } from "./login.js";
import { alignBodyToNow, type AlignOptions } from "./align.js";
import { validateSaveJson } from "./validate.js";

/** 会话级请求头（逆向确证 2026-08-04：imei=UUID(android_id.hashCode)；v1=MD5(ts) 动态；UA=公式；client=buildClient） */
export interface SessionHeaders {
  imei: string;
  v1: string;
  client: string;
  userAgent: string;
}

export const DEFAULT_SESSION_HEADERS: SessionHeaders = {
  imei: androidIdToImei("c1f2d3e4a5b67890"),
  // v1 每次请求动态 = MD5(now_ms)（signRequest 内生成；显式 session.v1 时优先）
  v1: "",
  client: "",
  userAgent: buildUserAgent(),
};

export interface FullSubmitInput {
  /** UploadJsonSports body（sportId 由 GET 注入；preview 用占位空串） */
  body: unknown;
  /** sensor 数值数组（generateSensor 输出） */
  sensorArray: number[];
  /** 覆盖 sensor 文件文本（默认 sensorToText(array)，含闭合 `]`） */
  sensorText?: string;
  config: SubmitConfig & { session?: Partial<SessionHeaders> };
  mode?: "preview" | "submit";
  /**
   * 提交瞬间时间对齐（官方 = 运动结束立即保存）。
   * ⚠️ 必须在 GET sportsId **之后**执行：保证 beginTime 晚于 sportId 签发
   *（原生生命周期 = 运动开始前先取 sportId）。
   * 默认启用；VM 基线等"原样重放"对照实验传 { enabled: false }（并配套 validate:false）。
   */
  align?: { enabled: boolean } & AlignOptions;
  /** 提交前 invariant 校验（默认 true）。对照实验传 false 显式放行矛盾数据 */
  validate?: boolean;
  /**
   * 第一阶段实验：savesports 前先发 prejudgment（feature-flagged，默认关闭）。
   * 开启后流程 = GET sportId → prejudgmentSnapshot → prejudgment → finalSnapshot → savesports → sensor。
   * 双快照来自同一 final body 派生（深拷贝），分别序列化/加密/签名，互不复用。
   * ⚠️ 仅本地 mock/受控环境验证请求形态与不变式；未获授权前不对正式服务器开启。
   */
  prejudgment?: {
    enabled: boolean;
    stepDelta?: number;
    endDeltaSec?: number;
  };
}

export interface StepResult {
  code: number;
  message: string;
  data: unknown;
  /** ★ 2026-08-04：sensorZipFile 校验失败标记（真实响应 data:"-1"） */
  sensorRejected?: boolean;
}

export interface FullSubmitOutcome {
  ok: true;
  mode: "preview" | "submit";
  /**
   * 业务有效性：是否同时满足归档成功条件
   * `isValid="1" && checkStatus="1" && inValidReason 为空`。
   * ⚠️ ok:true 只代表 3 个 HTTP 请求执行完毕，不代表运动有效。
   * ⚠️ gyroUploadStatus（传感器上传状态）单独看 save.gyroUploadStatus，不算入 businessValid。
   */
  businessValid: boolean;
  /** 真实 sportId（preview 为占位） */
  sportId: string;
  save: StepResult & {
    isValid?: string;
    inValidReason?: string;
    checkStatus?: string;
    tip?: string;
    /** 传感器上传状态（单独表示，不并入 businessValid） */
    gyroUploadStatus?: string;
  };
  sensor: StepResult;
  /** prejudgment 步骤结果（feature-flagged 开启时存在） */
  prejudgment?: StepResult;
  prepared: {
    saveUrl: string;
    sensorUrl: string;
    saveHeaders: Record<string, string>;
    sensorHeaders: Record<string, string>;
    jsonsportsPreview: string;
    sensorZipPreview: string;
    sensorSampleCount: number;
    /** 提交明文字段名清单（不含 coordinate 明细，审查用） */
    jsonFields: string[];
    /** 提交明文的数值自洽摘要（审查用） */
    jsonDigest: Record<string, string>;
  };
}

export interface FullSubmitError {
  ok: false;
  error: string;
  status: number;
}

export type FullSubmitResult = FullSubmitOutcome | FullSubmitError;

export interface FullSubmitHandlerOptions {
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 允许的目标 origin（默认 loopback mock 白名单） */
  allowedOrigins?: Set<string>;
}

function buildSigner(config: SubmitConfig): Signer {
  if (config.signer === "replay") return new ReplaySigner(config.replayEntries ?? []);
  if (config.signer === "native") {
    if (!config.secret) throw new Error("native 签名需要 config.secret（登录 token 第 4 段）");
    return new NativeSigner({ secret: config.secret });
  }
  return new MockSigner();
}

function buildEncoder(config: SubmitConfig): BodyEncoder {
  return config.secret ? new NativeEncoder(config.secret) : new PassthroughEncoder();
}

/** 由 body 对象构造保存 JSON（sportId 注入） */
function buildSaveJson(body: unknown, sportId: string): string {
  const obj =
    body && typeof body === "object"
      ? { ...(body as Record<string, unknown>), sportId }
      : body;
  return JSON.stringify(obj);
}

/**
 * 完整 3 步提交。preview 只构造（不 GET sportId、不发送）；
 * submit 真实执行三请求，返回每步 code/message/data 与脱敏的构造预览。
 */
export async function handleFullSubmit(
  input: FullSubmitInput,
  opts: FullSubmitHandlerOptions = {},
): Promise<FullSubmitResult> {
  const mode: "preview" | "submit" = input.mode ?? "preview";
  const { body, config } = input;
  // 外发包留档层：请求/响应全部原样落盘（A 路旁路监听用，默认启用，7 天清理）。
  // 改为显式 auditedRequest 调用（带 endpoint/signPath/sportId 上下文）。
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!body || typeof body !== "object") {
    return { ok: false, error: "缺少 body（UploadJsonSports）", status: 400 };
  }
  if (!config?.baseUrl) {
    return { ok: false, error: "缺少 config.baseUrl", status: 400 };
  }
  if (!isAllowedBaseUrl(config.baseUrl, opts.allowedOrigins)) {
    return {
      ok: false,
      error: `baseUrl 不在白名单（默认仅 localhost:8787；真实目标需显式配置）：${config.baseUrl}`,
      status: 400,
    };
  }
  if (input.sensorArray && !Array.isArray(input.sensorArray)) {
    return { ok: false, error: "sensorArray 格式错误", status: 400 };
  }
  // ★ 2026-08-06 sensor 解绑：sensorArray 可选（空则跳过 sensorZipFile 上传）
  const sensorArray = input.sensorArray ?? [];

  // 提交前 invariant 校验（先以占位 sportId 语义跑一遍，提前拦截矛盾数据）
  const runValidate = input.validate ?? true;
  const alignOpts: AlignOptions = {
    offsetSec: input.align?.offsetSec,
    timezoneOffsetMin: input.align?.timezoneOffsetMin,
  };
  const alignEnabled = input.align?.enabled ?? true;
  if (runValidate) {
    const preErrors = validateSaveJson(body, {
      allowPlaceholderSportId: true,
      sensorSampleCount: sensorArray.length,
    });
    if (preErrors.length > 0) {
      return {
        ok: false,
        error: `body 校验失败：${preErrors.join("；")}`,
        status: 400,
      };
    }
  }

  // 有 SECRET 且未显式指定自定义 client 时，动态生成（AES-ECB(JSON{heap,root,t}, SECRET[:16])）
  // 更"像真机"：client 每次请求都随 t 变化（真实 App 行为一致）。
  const explicitClient =
    config.session?.client && config.session.client !== DEFAULT_SESSION_HEADERS.client;
  const session: SessionHeaders = {
    ...DEFAULT_SESSION_HEADERS,
    ...(config.session ?? {}),
  };
  const getClient = (): string => {
    if (explicitClient) return session.client;
    if (config.secret) {
      try {
        return buildClient(config.secret);
      } catch {
        /* 生成失败则用默认 */
      }
    }
    return session.client;
  };
  session.client = getClient();
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;

  let signer: Signer;
  let encoder: BodyEncoder;
  try {
    signer = buildSigner(config);
    encoder = buildEncoder(config);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: 400,
    };
  }

  // 离线可构造：sensor zip + savesports 签名路径（preview 用占位 sportId）
  const sensorText = input.sensorText ?? (sensorArray.length > 0 ? sensorToText(sensorArray) : "");
  const sensorZip = sensorText ? gzipSync(Buffer.from(sensorText, "utf-8")).toString("base64") : "";

  const sportIdPlaceholder = "";
  // preview/展示用 body：提交瞬间对齐（与 submit 路径同语义；VM 基线等原样对照传 align=false）
  const previewBody = alignEnabled
    ? alignBodyToNow(body as Parameters<typeof alignBodyToNow>[0], alignOpts)
    : body;
  const saveJson = buildSaveJson(previewBody, sportIdPlaceholder);
  let jsonsports: string;
  try {
    jsonsports = await encoder.encode(saveJson);
  } catch (error) {
    return {
      ok: false,
      error: `Body 加密失败：${error instanceof Error ? error.message : String(error)}`,
      status: 400,
    };
  }

  /** 签名并返回 (url, headers)。requestPath = 实际请求 URL 路径；signPath = 参与签名的路径（可含额外 query）。 */
  async function signRequest(
    requestPath: string,
    signPath: string,
    // ★ 2026-08-25 修复：method 参数化（原硬编码 POST，复用于 GET 端点会签错）
    method: "GET" | "POST" = "POST",
    keyV1?: string,
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    sig: { timestamp: string; sign: string };
  }> {
    const sig = await signer.sign({ method, signPath: `/${signPath}` });
    const url = `${base}${requestPath}`;
    const headers: Record<string, string> = {
      imei: session.imei,
      v1: session.v1 || buildV1(undefined, keyV1),
      timestamp: sig.timestamp,
      sign: sig.sign,
      cgAuthorization: config.token,
      "User-Agent": session.userAgent,
      client: getClient(),
    };
    return { url, headers, sig };
  }

  // ★ 已确证：savesports 实际请求 URL **不含** ?jsonsports=（官方抓包 URL 无 query）；
  //   只有签名输入包含它（`/api/l/v7/savesports?jsonsports=<密文>`）。
  // ★ UploadJsonSports.build(sportBean, true) 在 savesports 前写入 key_v1 = this.odometer
  const previewOdometer = String((previewBody as Record<string, unknown>).odometer ?? "");
  const saveRequestPath = saveSports.path;
  const saveSignPath = `${saveSports.path}?jsonsports=${jsonsports}`;
  const savePrepared = await signRequest(saveRequestPath, saveSignPath, "POST", previewOdometer);
  savePrepared.headers["Content-Type"] = "application/x-www-form-urlencoded";

  // ★ sensor 上传：URL 与签名都含 query（官方抓包 URL 有 `?sportId=..&sensorZipFile=..`）
  const sensorQuery = `sportId=${sportIdPlaceholder}&sensorZipFile=${sportIdPlaceholder}.txt`;
  const sensorPrepared = await signRequest(`${uploadSensorZip.path}?${sensorQuery}`, `${uploadSensorZip.path}?${sensorQuery}`);

  // 审查摘要：字段名 + 数值自洽关键项（coordinate 明细不进响应）
  function buildDigest(json: string): { jsonFields: string[]; jsonDigest: Record<string, string> } {
    try {
      const obj = JSON.parse(json) as Record<string, unknown>;
      const coords = Array.isArray(obj.coordinate)
        ? (obj.coordinate as Array<Record<string, number>>)
        : [];
      const last = coords[coords.length - 1];
      return {
        jsonFields: Object.keys(obj),
        jsonDigest: {
          points: String(coords.length),
          odometer: String(obj.odometer),
          da_last: last ? String(last.da) : "",
          stepCount: String(obj.stepCount),
          sta_last: last ? String(last.sta) : "",
          stepMinute: String(obj.stepMinute),
          calorie: String(obj.calorie),
          avgSpeed: String(obj.avgSpeed),
          maxSpeedPerHour: String(obj.maxSpeedPerHour),
          minSpeedPerHour: String(obj.minSpeedPerHour),
          activeTime: String(obj.activeTime),
          avgPace: String(obj.avgPace),
          beginTime: String(obj.beginTime),
          endTime: String(obj.endTime),
          t_first: coords.length ? String(coords[0]!.t) : "",
          t_last: coords.length ? String(coords[coords.length - 1]!.t) : "",
          name: String(obj.name),
          phoneVersion: String(obj.phoneVersion),
          modementMode: String(obj.modementMode),
          routeId: String(obj.routeId),
        },
      };
    } catch {
      return { jsonFields: [], jsonDigest: {} };
    }
  }
  const digest = buildDigest(saveJson);
  const prepared: FullSubmitOutcome["prepared"] = {
    saveUrl: savePrepared.url,
    sensorUrl: sensorPrepared.url,
    saveHeaders: redactHeaders(savePrepared.headers),
    sensorHeaders: redactHeaders(sensorPrepared.headers),
    jsonsportsPreview: jsonsports.slice(0, 200),
    sensorZipPreview: sensorZip.slice(0, 80),
    sensorSampleCount: sensorArray.length,
    ...digest,
  };

  // preview：到此为止，绝不外发（不 GET sportId）
  if (mode === "preview") {
    return {
      ok: true,
      mode,
      businessValid: false,
      sportId: sportIdPlaceholder,
      save: { code: 0, message: "（preview 模式，未发送）", data: null },
      sensor: { code: 0, message: "（preview 模式，未发送）", data: null },
      prepared,
    };
  }

  // ---- submit ----
  let sportId: string;
  try {
    const url = `${base}${sportsId.path}`;
    const signPath = `/${sportsId.path}`;
    const sig = await signer.sign({ method: "GET", signPath });
    const headers: Record<string, string> = {
      imei: session.imei,
      v1: session.v1 || buildV1(),
      timestamp: sig.timestamp,
      sign: sig.sign,
      cgAuthorization: config.token,
      "User-Agent": session.userAgent,
      client: session.client,
    };
    const resp = await auditedRequest(
      fetchImpl,
      { endpoint: "sportsId", signPath },
      url,
      { method: "GET", headers },
    );
    const api = (await resp.json()) as { code: number; message: string; data?: unknown };
    if (api.code !== 200) {
      return { ok: false, error: `sportId 失败: code=${api.code} msg=${api.message}`, status: 502 };
    }
    sportId = typeof api.data === "string" ? api.data : String((api.data as { value?: unknown })?.value ?? "");
    if (!sportId) return { ok: false, error: "sportId 为空", status: 502 };
  } catch (error) {
    return {
      ok: false,
      error: `sportId 请求失败：${error instanceof Error ? error.message : String(error)}`,
      status: 502,
    };
  }

  // savesports（sportId 注入，重新构造并签名）
  // ★ 请求 URL 不含 jsonsports query；签名输入含 `?jsonsports=<密文>`（已确证）
  // ★ 对齐必须发生在 GET sportsId **之后**：beginTime 必须晚于 sportId 签发
  //   （原生生命周期：运动开始前先取 sportId → 采集 → 结束立即保存）。
  const realBody = alignEnabled
    ? alignBodyToNow(body as Parameters<typeof alignBodyToNow>[0], alignOpts)
    : body;
  // ★ sportId 先合并进 body 对象再校验（注入发生在 buildSaveJson 之前，
  //   validate 必须看到已注入的值——此前校验了注入前的 body 导致误报"未注入"）。
  const injected = { ...(realBody as Record<string, unknown>), sportId };
  if (runValidate) {
    const postErrors = validateSaveJson(injected, {
      allowPlaceholderSportId: false,
      sensorSampleCount: sensorArray.length,
    });
    if (postErrors.length > 0) {
      return {
        ok: false,
        error: `提交前校验失败：${postErrors.join("；")}`,
        status: 400,
      };
    }
  }

  // ★ prejudgment（feature-flagged，默认关闭）：savesports 前先发"结束时刻快照"
  let prejudgmentResult: StepResult | undefined;
  const pjFlag = input.prejudgment?.enabled ?? false;
  if (pjFlag) {
    const pjSnapshot = buildPrejudgmentSnapshot(injected, {
      stepDelta: input.prejudgment?.stepDelta,
      endDeltaSec: input.prejudgment?.endDeltaSec,
    });
    const invariantErrors = assertSnapshotInvariants(pjSnapshot, injected);
    if (invariantErrors.length > 0) {
      return { ok: false, error: `prejudgment 快照不变式失败：${invariantErrors.join("；")}`, status: 400 };
    }
    const pjJson = JSON.stringify(pjSnapshot);
    const pjCipher = await encoder.encode(pjJson);
    // ★ 请求形态（第一/二阶段边界）：URL 干净 + form body 放密文；signPath 带 ?jsonsports=<密文>
    //   真实 HTTP 形态待第二阶段 SSL 报文确认，此实现与 savesports 平行约定。
    const pjSignPath = `${prejudgment.path}?jsonsports=${pjCipher}`;
    const pjSig = await signer.sign({ method: "POST", signPath: `/${pjSignPath}` });
    const pjUrl = `${base}${prejudgment.path}`;
    const pjHeaders: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      imei: session.imei,
      v1: session.v1 || buildV1(),
      timestamp: pjSig.timestamp,
      sign: pjSig.sign,
      cgAuthorization: config.token,
      "User-Agent": session.userAgent,
      client: session.client,
    };
    try {
      const pjBody = new URLSearchParams({ jsonsports: pjCipher });
      const pjResp = await auditedRequest(
        fetchImpl,
        { endpoint: "prejudgment", signPath: `/${pjSignPath}`, sportId },
        pjUrl,
        { method: "POST", headers: pjHeaders, body: pjBody },
      );
      const pjApi = (await pjResp.json()) as { code: number; message: string; data?: unknown };
      prejudgmentResult = { code: pjApi.code, message: pjApi.message, data: pjApi.data };
    } catch (error) {
      return {
        ok: false,
        error: `prejudgment 请求失败：${error instanceof Error ? error.message : String(error)}`,
        status: 502,
      };
    }
  }

  const saveJsonReal = buildSaveJson(injected, sportId);
  const jsonsportsReal = await encoder.encode(saveJsonReal);
  const saveSignPathReal = `${saveSports.path}?jsonsports=${jsonsportsReal}`;
  const saveSig = await signer.sign({ method: "POST", signPath: `/${saveSignPathReal}` });
  const saveUrlReal = `${base}${saveSports.path}`;
  // ★ savesports 专属：UploadJsonSports.build(sportBean, true) 写入 SP["key_v1"] = this.odometer
  const saveOdometer = String((injected as Record<string, unknown>).odometer ?? "");
  const saveHeadersReal: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    imei: session.imei,
    v1: session.v1 || buildV1(undefined, saveOdometer),
    timestamp: saveSig.timestamp,
    sign: saveSig.sign,
    cgAuthorization: config.token,
    "User-Agent": session.userAgent,
    client: getClient(),
  };
  let saveResult: FullSubmitOutcome["save"];
  // ★ 2026-08-05：upload 用 savesports 响应回显的 sportId（真机行为）；缺省 fallback GET 值。
  //   定义在 try 外：sensor 阶段也要用
  let uploadSportId = sportId;
  try {
    const saveBody = new URLSearchParams({ jsonsports: jsonsportsReal });
    const resp = await auditedRequest(
      fetchImpl,
      { endpoint: "savesports", signPath: `/${saveSignPathReal}`, sportId },
      saveUrlReal,
      { method: "POST", headers: saveHeadersReal, body: saveBody },
    );
    const api = (await resp.json()) as {
      code: number;
      message: string;
      data?: Record<string, unknown> | null;
    };
    const d = api.data;
    // 真机链路：upload 使用 savesports.response.data.sportId（回显值）
    if (d && typeof d.sportId === "string" && d.sportId.length > 0) {
      uploadSportId = d.sportId;
    }
    saveResult = {
      code: api.code,
      message: api.message,
      data: d,
      isValid: d?.isValid as string | undefined,
      inValidReason: d?.inValidReason as string | undefined,
      checkStatus: d?.checkStatus as string | undefined,
      tip: d?.tip as string | undefined,
      gyroUploadStatus: d?.gyroUploadStatus as string | undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: `savesports 请求失败：${error instanceof Error ? error.message : String(error)}`,
      status: 502,
    };
  }

  // sensorZipFile（sportId 注入，重新签名）
  // ★ 2026-08-05：URL/签名/multipart 全部使用 savesports 响应回显的 uploadSportId（真机行为）
  // ★ 2026-08-06 sensor 解绑：sensorZip 为空（sensorArray 未传）则跳过上传
  let sensorResult: StepResult = { code: -1, message: "跳过（sensor 解绑）", data: null };
  if (sensorZip) {
    try {
      const sensorPathReal = `${uploadSensorZip.path}?sportId=${uploadSportId}&sensorZipFile=${uploadSportId}.txt`;
      const sensorSig = await signer.sign({ method: "POST", signPath: `/${sensorPathReal}` });
      const sensorUrlReal = `${base}${sensorPathReal}`;
      const sensorHeadersReal: Record<string, string> = {
        imei: session.imei,
        v1: session.v1 || buildV1(),
        timestamp: sensorSig.timestamp,
        sign: sensorSig.sign,
        cgAuthorization: config.token,
        "User-Agent": session.userAgent,
        client: session.client,
      };
      const fd = new FormData();
      fd.append("sportId", uploadSportId);
      fd.append("sensorZipFile", `${uploadSportId}.txt`);
      fd.append(`${uploadSportId}.txt`, new Blob([sensorZip], { type: "application/octet-stream" }));
      const resp = await auditedRequest(
        fetchImpl,
        { endpoint: "sensorZipFile", signPath: `/${sensorPathReal}`, sportId: uploadSportId },
        sensorUrlReal,
        { method: "POST", headers: sensorHeadersReal, body: fd },
      );
      const api = (await resp.json()) as { code: number; message: string; data?: unknown };
      // ★ 2026-08-04：真实服务端 sensorZipFile 校验失败返回 data:"-1"（字符串，非 SportResult）
      //   标记 sensorRejected，便于上层区分"上传成功"与"传感器文件校验失败"
      sensorResult = {
        code: api.code,
        message: api.message,
        data: api.data,
        sensorRejected: api.data === "-1",
      };
    } catch (error) {
      return {
        ok: false,
        error: `sensorZipFile 请求失败：${error instanceof Error ? error.message : String(error)}`,
        status: 502,
      };
    }
  }

  // 归档成功条件：isValid=1 AND checkStatus=1 AND inValidReason 为空
  const businessValid =
    saveResult.isValid === "1" &&
    saveResult.checkStatus === "1" &&
    (saveResult.inValidReason === "" ||
      saveResult.inValidReason === null ||
      saveResult.inValidReason === undefined);
  return {
    ok: true,
    mode,
    businessValid,
    // ★ 2026-08-05：返回实际用于 upload 的 sportId（savesports 响应回显值；与 GET 值一致时不变）
    sportId: uploadSportId,
    save: saveResult,
    sensor: sensorResult,
    ...(prejudgmentResult ? { prejudgment: prejudgmentResult } : {}),
    prepared,
  };
}

/**
 * 验重防抖（实验性）：对 body 的"无关紧要的小数位"做确定性微扰，避免与已存在记录逐字节相同。
 * 只动坐标 a/o（±~1e-6）、速度 s、单段距离 d（并按比例重算累计 da 与 odometer），
 * 保证内部自洽（sum(d)≈末点 da，odometer=da/1000）。
 */
export function jitterUploadBody(body: unknown, rngSeed = 20260801): unknown {
  if (!body || typeof body !== "object") return body;
  const obj = { ...(body as Record<string, unknown>) };
  const coords = Array.isArray(obj.coordinate)
    ? (obj.coordinate as Array<Record<string, number>>).map((c) => ({ ...c }))
    : [];
  if (coords.length === 0) return obj;

  // 确定性伪随机 ±1
  let s = rngSeed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 2; // [-1,1]
  };

  // 先给 a/o 加微小扰动（位置 ~0.1m 级），d 乘以统一因子，再重算 da
  const dFactor = 1 + rnd() * 0.0004; // ±0.02%
  let da = 0;
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]!;
    // ★ 2026-08-25 修复：首点仅豁免 a/o/s 扰动（"首点标记不动"），d/da 累计照常执行
    //   （真实数据首点 d=0/da=0，行为不变；协议自洽要求 sum(d)=末点 da 从首点起算）
    if (i > 0) {
      if (typeof c.a === "number" && typeof c.o === "number") {
        c.a = Math.round((c.a + rnd() * 2e-6) * 1e6) / 1e6;
        c.o = Math.round((c.o + rnd() * 2e-6) * 1e6) / 1e6;
      }
      if (typeof c.s === "number") c.s = Math.round(c.s * (1 + rnd() * 0.0006) * 100) / 100;
    }
    if (typeof c.d === "number") {
      c.d = Math.round(c.d * dFactor * 1000) / 1000;
      da += c.d;
      c.da = Math.round(da * 1000) / 1000;
    }
  }
  obj.coordinate = coords;
  const lastDa = coords.length > 1 ? (coords[coords.length - 1]!.da as number) : 0;
  if (lastDa > 0) obj.odometer = (lastDa / 1000).toFixed(2);
  return obj;
}
