/**
 * 预定发布（2026-08-05）—— 完整原生生命周期重放。
 *
 * 生命周期（原生两阶段提交协议）：
 *   T1: POST /api/l/v6.1/sporttype/inSportTime?sportTypeId=<范围id>
 *       服务端记录"运动开始"（到达时刻 = 运动开始时刻）★ 此前直连跳过 → reason 24
 *   T2: GET  /api/l/v7/sportsId                        （会话锚点）
 *   T3: 等待 until T1 + durationSec（运动"进行中"）
 *   T4: POST prejudgment → savesports（beginTime=T1, endTime=T1+duration）
 *       → sensorZipFile（上传完成后才提交结束）
 *
 * 关键约束：
 *   - beginTime 必须 ≥ inSportTime 时刻（服务端保存的运动开始状态）
 *   - endTime ≈ 提交时刻（原生"运动结束立即保存"）
 *   - 因此 T3 等待时长 ≈ durationSec - 预处理耗时
 *
 * 安全：与 full-submit 一致，preview 只构造不发送；白名单 baseUrl。
 */

import { gzipSync } from "node:zlib";
import { NativeSigner, MockSigner, ReplaySigner, type Signer } from "./signer.js";
import { NativeEncoder, PassthroughEncoder, type BodyEncoder } from "./encoder.js";
import { sportsId, saveSports, uploadSensorZip, prejudgment, inSportTime } from "./endpoint.js";
import { DEFAULT_SESSION_HEADERS, type SessionHeaders } from "./full-submit.js";
import { buildV1 } from "./device.js";
import { buildClient } from "./login.js";
import { isAllowedBaseUrl, type SubmitConfig } from "./submit-handler.js";
import { auditedRequest } from "./outbound-trace.js";
import { alignBodyToTarget } from "./align.js";
import { buildPrejudgmentSnapshot, assertSnapshotInvariants } from "./prejudgment.js";
import { sensorToText } from "./sensor.js";
import { validateSaveJson } from "./validate.js";

export interface ScheduledSubmitInput {
  /** UploadJsonSports body（相对时间轴，坐标 t 相对毫秒） */
  body: unknown;
  /** sensor 数值数组 */
  sensorArray: number[];
  /** sporttype 范围 id（= inSportTime 的 sportTypeId，如 27） */
  sportTypeId: string;
  /** 预定开始时刻（epoch ms）= inSportTime 时刻 */
  startAtMs: number;
  config: SubmitConfig & { session?: Partial<SessionHeaders> };
  mode?: "preview" | "submit";
  /** ★ 2026-08-05 两阶段：stage="begin" 只做 inSportTime+sportsId（秒回），
   *  stage="commit" 用 begin 返回的 sportId 做 savesports+sensorZipFile */
  stage?: "begin" | "commit";
  /** begin 阶段返回的会话（commit 阶段必传） */
  session?: { sportId: string; startAtMs: number; commitAtLocalMs?: number; clockOffsetMs?: number };
  /** 设备时区偏移（分钟）；0=UTC（VM），480=东八区 */
  timezoneOffsetMin?: number;
  /** 提交前 invariant 校验（默认 true） */
  validate?: boolean;
  /** ★ 2026-08-05 暂停快照（prejudgment）选项：默认开启（真实生命周期必发） */
  prejudgment?: false | { stepDelta?: number; endDeltaSec?: number };
  /** ★ 暂停停留时长 ms（prejudgment 与 savesports 之间，默认 5000） */
  pauseMs?: number;
  /** ★ savesports 与 sensorZipFile 之间间隔 ms（真实分阶段，默认 3000） */
  uploadGapMs?: number;
  /** 测试注入等待器（默认 setTimeout promisify） */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  allowedOrigins?: Set<string>;
}

export interface ScheduledStep {
  key: string;
  code: number;
  message: string;
  data: unknown;
}

export interface ScheduledSubmitOutcome {
  ok: true;
  mode: "preview" | "submit";
  /** 会话 sportId（GET sportsId 签发） */
  sportId: string;
  /** 各步骤结果（含 inSportTime/sportsId/prejudgment/savesports/sensorZipFile） */
  steps: ScheduledStep[];
  /** savesports 业务判定 */
  businessValid: boolean;
  save?: ScheduledStep & { isValid?: string; inValidReason?: string; checkStatus?: string; tip?: string };
  /** ★ 兼容 FullSubmitOutcome：sensorZipFile 步骤（供 viewer 通用渲染） */
  sensor?: ScheduledStep;
  /** 等待时长（submit 模式实际 sleep ms） */
  waitedMs: number;
  /** ★ 两阶段：begin 阶段返回会话（commit 阶段回传） */
  scheduledSession?: {
    sportId: string;
    startAtMs: number;
    endAtMs: number;
    commitAtLocalMs?: number;
    clockOffsetMs?: number;
  };
  /** 构造预览（脱敏） */
  prepared: {
    inSportTimeUrl: string;
    saveUrl: string;
    sensorUrl: string;
    beginTime: string;
    endTime: string;
    sportTypeId: string;
  };
}

export type ScheduledSubmitResult = ScheduledSubmitOutcome | { ok: false; error: string; status: number };

function buildSigner(config: SubmitConfig): Signer {
  if (config.signer === "replay") return new ReplaySigner(config.replayEntries ?? []);
  if (config.signer === "native") {
    if (!config.secret) throw new Error("native 签名需要 config.secret");
    return new NativeSigner({ secret: config.secret });
  }
  return new MockSigner();
}

function buildEncoder(config: SubmitConfig): BodyEncoder {
  return config.secret ? new NativeEncoder(config.secret) : new PassthroughEncoder();
}

export interface ScheduledSubmitHandlerOptions {
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 允许的目标 origin（默认 loopback mock 白名单） */
  allowedOrigins?: Set<string>;
  /** TUI 的加密任务账本替代旧的原始外发日志；默认保持 viewer 行为。 */
  audit?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function handleScheduledSubmit(
  input: ScheduledSubmitInput,
  opts: ScheduledSubmitHandlerOptions = {},
): Promise<ScheduledSubmitResult> {
  const mode: "preview" | "submit" = input.mode ?? "preview";
  const { body, config } = input;

  if (!body || typeof body !== "object") return { ok: false, error: "缺少 body", status: 400 };
  if (!config?.baseUrl) return { ok: false, error: "缺少 config.baseUrl", status: 400 };
  if (!isAllowedBaseUrl(config.baseUrl, opts.allowedOrigins ?? input.allowedOrigins)) {
    return { ok: false, error: `baseUrl 不在白名单：${config.baseUrl}`, status: 400 };
  }
  if (!Array.isArray(input.sensorArray)) {
    // ★ 2026-08-06 sensor 解绑：sensorArray 可选——不传 sensor 也能提交
    //   （时序铁证：savesports 判定在 sensorZipFile 之前，sensor 不影响 isValid）
    //   空数组 = 跳过 sensorZipFile 上传
  }
  if (!input.sportTypeId) return { ok: false, error: "缺少 sportTypeId", status: 400 };
  // ★ 2026-08-05 点击即开始：startAtMs 缺省 = 当前时刻（inSportTime 服务端记录 = 点击时刻）
  const startAtMs = input.startAtMs && Number.isFinite(input.startAtMs) && input.startAtMs > 0
    ? input.startAtMs
    : Date.now();

  // 会话头组装（与 full-submit 同规则）
  if (!config.session?.imei?.trim() || !config.session.userAgent || (config.imei && config.imei !== config.session.imei))
    return { ok: false, error: "账号设备档案缺失或不匹配。", status: 400 };
  const explicitClient =
    config.session?.client && config.session.client !== DEFAULT_SESSION_HEADERS.client;
  const session: SessionHeaders = { ...DEFAULT_SESSION_HEADERS, ...(config.session ?? {}) };
  let clockOffsetMs = input.session?.clockOffsetMs ?? 0;
  const nowServerMs = () => Date.now() + clockOffsetMs;
  const getClient = (): string => {
    if (explicitClient) return session.client;
    if (config.secret) {
      try { return buildClient(config.secret, nowServerMs()); } catch { /* keep default */ }
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
    return { ok: false, error: error instanceof Error ? error.message : String(error), status: 400 };
  }

  // 计算时间窗：begin=startAtMs, end=startAtMs+轨迹时长
  const coords = Array.isArray((body as Record<string, unknown>).coordinate)
    ? ((body as Record<string, unknown>).coordinate as Array<{ t: number }>)
    : [];
  const ts = coords.map((c) => c.t).filter((t) => t && t > 0);
  if (ts.length === 0) return { ok: false, error: "body 无有效坐标时间戳", status: 400 };
  const durationMs = Math.max(...ts) - Math.min(...ts);
  const tzMin = input.timezoneOffsetMin ?? 0;
  // ★ 2026-08-05 点击即开始：begin 阶段 startAtMs=now（或用户指定）；commit 阶段复用会话值
  let sessionStartMs = input.session?.startAtMs && input.session.startAtMs > 0
    ? input.session.startAtMs
    : startAtMs;
  let endAtMs = sessionStartMs + durationMs;

  // 对齐到运动时间窗（beginTime=sessionStartMs 语义）
  let aligned = alignBodyToTarget(body, endAtMs, { timezoneOffsetMin: tzMin });

  const sensorText = input.sensorArray.length > 0 ? sensorToText(input.sensorArray) : "";
  const sensorZip = sensorText ? gzipSync(Buffer.from(sensorText, "utf-8")).toString("base64") : "";

  // 构造各步骤（先签名构造，preview 到此为止）
  const inSportTimePath = `${inSportTime.path}?sportTypeId=${input.sportTypeId}`;
  const sensorQuery = `sportId=<sid>&sensorZipFile=<sid>.txt`;

  // preview：不发送（与 full-submit 语义一致）
  const prepared = {
    inSportTimeUrl: `${base}${inSportTimePath}`,
    saveUrl: `${base}${saveSports.path}`,
    sensorUrl: `${base}${uploadSensorZip.path}?${sensorQuery}`,
    beginTime: String((aligned as Record<string, unknown>).beginTime),
    endTime: String((aligned as Record<string, unknown>).endTime),
    sportTypeId: input.sportTypeId,
  };

  if (mode === "preview") {
    return {
      ok: true,
      mode,
      sportId: "",
      steps: [],
      businessValid: false,
      waitedMs: 0,
      prepared,
    };
  }

  // ---- submit ----
  const stage = input.stage ?? "commit";
  const steps: ScheduledStep[] = [];
  const wait = input.wait ?? sleep;
  const fetchImpl = opts.fetchImpl ?? input.fetchImpl ?? fetch;
  const request: typeof auditedRequest = opts.audit === false
    ? async (impl, _ctx, url, init) => impl(url, init)
    : auditedRequest;
  const runValidate = input.validate ?? true;

  const mkHeaders = (sig: { timestamp: string; sign: string }, keyV1?: string) => ({
    imei: session.imei,
    v1: session.v1 || buildV1(nowServerMs(), keyV1),
    timestamp: sig.timestamp,
    sign: sig.sign,
    cgAuthorization: config.token,
    "User-Agent": session.userAgent,
    client: getClient(),
  });

  // ★ 两阶段：commit 阶段复用 begin 返回的 sportId，跳过 inSportTime/sportsId
  let sportId = input.session?.sportId ?? "";

  if (stage === "begin") {
    // 0. 预检：在真正调用服务端 inSportTime/sportsId 前先跑一遍本地校验，
    //    绝不允许等了 20 分钟到 commit 阶段才因为本地字段/sensor 长度问题报错！
    if (runValidate) {
      const precheckErrors = validateSaveJson(
        { ...(aligned as Record<string, unknown>), sportId: "PRECHECK-SID" },
        {
          allowPlaceholderSportId: false,
          sensorSampleCount: input.sensorArray.length,
        },
      );
      if (precheckErrors.length > 0) {
        return {
          ok: false,
          error: `预定开始前预检失败：${precheckErrors.join("；")}`,
          status: 400,
        };
      }
    }
    // 1. inSportTime（运动开始上报）—— ★ 2026-08-05 实测为 GET（POST 返回 405）
    try {
      const sig = await signer.sign({ method: "GET", signPath: `/${inSportTimePath}` });
      const resp = await request(
        fetchImpl,
        { endpoint: "inSportTime", signPath: `/${inSportTimePath}`, sportId: "" },
        `${base}${inSportTimePath}`,
        { method: "GET", headers: mkHeaders(sig) },
      );
      const api = (await resp.json()) as { code: number; message: string; data?: unknown };
      steps.push({ key: "inSportTime", code: api.code, message: api.message, data: api.data });
      if (api.code !== 200) {
        return { ok: false, error: `inSportTime 失败: code=${api.code}`, status: 502 };
      }
    } catch (error) {
      return { ok: false, error: `inSportTime 请求失败：${error instanceof Error ? error.message : String(error)}`, status: 502 };
    }

    // 2. GET sportsId
    let srvDateHeader: string | null = null;
    try {
      const sig = await signer.sign({ method: "GET", signPath: `/${sportsId.path}` });
      const resp = await request(
        fetchImpl,
        { endpoint: "sportsId", signPath: `/${sportsId.path}` },
        `${base}${sportsId.path}`,
        { method: "GET", headers: mkHeaders(sig) },
      );
      srvDateHeader = resp.headers?.get?.("date") ?? null;
      const api = (await resp.json()) as { code: number; message: string; data?: unknown };
      steps.push({ key: "sportsId", code: api.code, message: api.message, data: api.data });
      if (api.code !== 200) return { ok: false, error: `sportsId 失败: code=${api.code}`, status: 502 };
      sportId = typeof api.data === "string" ? api.data : String((api.data as { value?: unknown })?.value ?? "");
      if (!sportId) return { ok: false, error: "sportId 为空", status: 502 };
    } catch (error) {
      return { ok: false, error: `sportsId 请求失败：${error instanceof Error ? error.message : String(error)}`, status: 502 };
    }

    // ★ 校准服务端时钟偏移 + 3 秒倒计时（ExercisePresenter.mo1153）：
    //   若服务端响应含 Date 头（真实环境本机可能慢于服务端），以服务端时间 + 3s 为 beginTime，
    //   并加 intervalMs(2000ms) 抵消 alignBodyToTarget 的首正点回退，保证 beginTime > sportsId 签发时刻。
    const localAfterBegin = Date.now();
    let commitAtLocalMs = localAfterBegin + durationMs + 5000;
    if (srvDateHeader) {
      const parsedSrv = Date.parse(srvDateHeader);
      if (Number.isFinite(parsedSrv)) {
        clockOffsetMs = parsedSrv + 500 - localAfterBegin;
        const srvNow = localAfterBegin + clockOffsetMs;
        const realBeginMs = Math.ceil((srvNow + 3000) / 1000) * 1000;
        sessionStartMs = realBeginMs + 2000;
        endAtMs = sessionStartMs + durationMs;
        aligned = alignBodyToTarget(body, endAtMs, { timezoneOffsetMin: tzMin });
        prepared.beginTime = String((aligned as Record<string, unknown>).beginTime);
        prepared.endTime = String((aligned as Record<string, unknown>).endTime);
      }
    } else if (!input.startAtMs) {
      const realBeginMs = Math.ceil((localAfterBegin + 3000) / 1000) * 1000;
      sessionStartMs = realBeginMs + 2000;
      endAtMs = sessionStartMs + durationMs;
      aligned = alignBodyToTarget(body, endAtMs, { timezoneOffsetMin: tzMin });
      prepared.beginTime = String((aligned as Record<string, unknown>).beginTime);
      prepared.endTime = String((aligned as Record<string, unknown>).endTime);
    }

    // ★ begin 阶段秒回：不等待、不提交，会话交给前端
    return {
      ok: true,
      mode,
      sportId,
      steps,
      businessValid: false,
      waitedMs: 0,
      scheduledSession: { sportId, startAtMs: sessionStartMs, endAtMs, commitAtLocalMs, clockOffsetMs },
      prepared,
    };
  }

  // ---- commit 阶段：必须携带 begin 返回的会话 ----
  if (!sportId) {
    return { ok: false, error: "commit 阶段缺少 scheduledSession.sportId（先执行 begin）", status: 400 };
  }

  // 3. 等待到运动结束时刻（预定发布核心）
  const nowMs = nowServerMs();
  const waitMs = Math.max(0, endAtMs - nowMs);
  if (waitMs > 0) await wait(waitMs);

  // 4. prejudgment（暂停快照）——★ 2026-08-05 全流程抓包确证：真实 App 每次暂停都发 prejudgment，
  //    服务端返回 3 条规则实时判定（距离/时间/时段）。savesports 前必发（生命周期完整性）。
  // 5. savesports（最终定格）→ wait → sensorZipFile（分阶段，不一口气连打）
  const injected = { ...(aligned as Record<string, unknown>), sportId };
  if (runValidate) {
    const errors = validateSaveJson(injected, {
      allowPlaceholderSportId: false,
      // ★ sensor 解绑：sensorSampleCount 传 0（跳过 sensor 相关校验）
      sensorSampleCount: input.sensorArray.length,
    });
    if (errors.length > 0) return { ok: false, error: `提交前校验失败：${errors.join("；")}`, status: 400 };
  }

  // ★ prejudgment（暂停快照）：buildPrejudgmentSnapshot 生成独立快照（无 coordinate、步数少、endTime 早）
  let prejudgmentStep: ScheduledStep | undefined;
  const pjOpts = input.prejudgment;
  if (pjOpts !== false) {
    const randStepDelta = 12 + Math.floor(Math.random() * 20); // 12~31 步随机差值（避免固定 27 步特征）
    const randEndDeltaSec = 5 + Math.floor(Math.random() * 6); // 5~10 秒随机暂停提前量（避免固定 8s 特征）
    const pjSnapshot = buildPrejudgmentSnapshot(injected, {
      stepDelta: pjOpts?.stepDelta ?? randStepDelta,
      endDeltaSec: pjOpts?.endDeltaSec ?? randEndDeltaSec,
    });
    const invariantErrors = assertSnapshotInvariants(pjSnapshot, injected);
    if (invariantErrors.length > 0) {
      return { ok: false, error: `prejudgment 快照不变式失败：${invariantErrors.join("；")}`, status: 400 };
    }
    try {
      const pjJson = JSON.stringify(pjSnapshot);
      const pjCipher = await encoder.encode(pjJson);
      // ★ 真实请求形态（全流程抓包确证）：URL 干净 + body 放密文；signPath 带 ?jsonsports=<密文>
      const pjSignPath = `${prejudgment.path}?jsonsports=${pjCipher}`;
      const pjSig = await signer.sign({ method: "POST", signPath: `/${pjSignPath}` });
      const pjResp = await request(
        fetchImpl,
        { endpoint: "prejudgment", signPath: `/${pjSignPath}`, sportId },
        `${base}${prejudgment.path}`,
        {
          method: "POST",
          headers: { ...mkHeaders(pjSig), "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ jsonsports: pjCipher }),
        },
      );
      const pjApi = (await pjResp.json()) as { code: number; message: string; data?: unknown };
      prejudgmentStep = { key: "prejudgment", code: pjApi.code, message: pjApi.message, data: pjApi.data };
      steps.push(prejudgmentStep);
      if (pjApi.code !== 200) {
        return { ok: false, error: `prejudgment 失败: code=${pjApi.code}`, status: 502 };
      }
    } catch (error) {
      return { ok: false, error: `prejudgment 请求失败：${error instanceof Error ? error.message : String(error)}`, status: 502 };
    }
    // ★ 暂停停留（真实 App 暂停后停留，再结束提交）
    const pauseMs = input.pauseMs ?? 5000;
    if (pauseMs > 0) await wait(pauseMs);
  }

  // savesports
  let saveStep: ScheduledSubmitOutcome["save"];
  let uploadSportId = sportId;
  try {
    const saveJson = JSON.stringify(injected);
    const cipher = await encoder.encode(saveJson);
    const signPath = `${saveSports.path}?jsonsports=${cipher}`;
    const sig = await signer.sign({ method: "POST", signPath: `/${signPath}` });
    // ★ savesports 专属：UploadJsonSports.build(sportBean, true) 写入 SP["key_v1"] = this.odometer
    const saveOdometer = String((injected as Record<string, unknown>).odometer ?? "");
    const headers = { ...mkHeaders(sig, saveOdometer), "Content-Type": "application/x-www-form-urlencoded" };
    const resp = await request(
      fetchImpl,
      { endpoint: "savesports", signPath: `/${signPath}`, sportId },
      `${base}${saveSports.path}`,
      { method: "POST", headers, body: new URLSearchParams({ jsonsports: cipher }) },
    );
    const api = (await resp.json()) as {
      code: number; message: string;
      data?: Record<string, unknown> | null;
    };
    const d = api.data;
    if (d && typeof d.sportId === "string" && d.sportId.length > 0) uploadSportId = d.sportId;
    saveStep = {
      key: "savesports",
      code: api.code,
      message: api.message,
      data: d,
      isValid: d?.isValid != null ? String(d.isValid) : undefined,
      inValidReason: (d?.inValidReason ?? d?.isValidReason) != null ? String(d?.inValidReason ?? d?.isValidReason) : undefined,
      checkStatus: d?.checkStatus != null ? String(d.checkStatus) : undefined,
      tip: d?.tip != null ? String(d.tip) : undefined,
    };
    steps.push(saveStep);
    if (api.code !== 200) return { ok: false, error: `savesports 失败: code=${api.code}`, status: 502 };
  } catch (error) {
    return { ok: false, error: `savesports 请求失败：${error instanceof Error ? error.message : String(error)}`, status: 502 };
  }

  // ★ 分阶段：savesports 与 sensorZipFile 之间间隔（真实 App 分步上传）
  const gapMs = input.uploadGapMs ?? 3000;
  if (gapMs > 0) await wait(gapMs);

  // sensorZipFile（★ 2026-08-06 sensor 解绑：sensorArray 为空则跳过）
  if (sensorZip) {
    try {
      const sensorPath = `${uploadSensorZip.path}?sportId=${uploadSportId}&sensorZipFile=${uploadSportId}.txt`;
      const sig = await signer.sign({ method: "POST", signPath: `/${sensorPath}` });
      const fd = new FormData();
      fd.append("sportId", uploadSportId);
      fd.append("sensorZipFile", `${uploadSportId}.txt`);
      fd.append(`${uploadSportId}.txt`, new Blob([sensorZip], { type: "application/octet-stream" }));
      const resp = await request(
        fetchImpl,
        { endpoint: "sensorZipFile", signPath: `/${sensorPath}`, sportId: uploadSportId },
        `${base}${sensorPath}`,
        { method: "POST", headers: mkHeaders(sig), body: fd },
      );
      const api = (await resp.json()) as { code: number; message: string; data?: unknown };
      steps.push({ key: "sensorZipFile", code: api.code, message: api.message, data: api.data });
      if (api.code !== 200) return { ok: false, error: `sensorZipFile 失败: code=${api.code}`, status: 502 };
    } catch (error) {
      return { ok: false, error: `sensorZipFile 请求失败：${error instanceof Error ? error.message : String(error)}`, status: 502 };
    }
  } else {
    steps.push({ key: "sensorZipFile", code: -1, message: "跳过（sensor 解绑）", data: null });
  }

  const businessValid =
    saveStep?.isValid === "1" &&
    saveStep?.checkStatus === "1" &&
    (saveStep?.inValidReason === "" || saveStep?.inValidReason === null || saveStep?.inValidReason === undefined);

  // ★ 兼容 SubmitPanel 的 isFull 逻辑：暴露 sensor 步骤（与 FullSubmitOutcome 同构）
  const sensorStep = steps.find((s) => s.key === "sensorZipFile");

  return {
    ok: true,
    mode,
    sportId: uploadSportId,
    steps,
    businessValid,
    save: saveStep,
    // 与 FullSubmitOutcome.sensor 同构（供 viewer 通用渲染）
    sensor: sensorStep
      ? { key: "sensorZipFile", code: sensorStep.code, message: sensorStep.message, data: sensorStep.data }
      : undefined,
    waitedMs: waitMs,
    prepared,
  };
}
