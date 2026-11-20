/**
 * 运动记录查询：GET /api/l/v7/sportlist（登录后查看自己的提交记录状态）。
 *
 * 供 viewer「查看我的记录」使用（点击才获取，不自动轮询）。
 * 只读 GET，风险低；服务端对 v1/client 不校验，可空。
 */

import { NativeSigner } from "./signer.js";
import { LOGIN_USER_AGENT, buildClient } from "./login.js";
import { buildV1 } from "./device.js";

export interface WorkoutRecord {
  /** 原 App 用 tableName 作为 sport/detail 的 term 参数。 */
  tableName?: string;
  beginTime: string;
  endTime: string;
  routeId: string;
  sportId: string;
  isValid: string;
  inValidReason: string;
  checkStatus: string;
  tip: string;
  subType: string;
  odometer: string;
  stepCount: string;
  avgSpeed: string;
  activeTime: string;
}

export interface FetchRecordsOptions {
  token: string;
  secret: string;
  xh: string;
  baseUrl?: string;
  /** sportlist type：1=本学期（当前学期），0=往期历史学期（App ERModel.C0984 实测） */
  type?: string;
  fetchImpl?: typeof fetch;
  session?: { imei: string; userAgent: string };
}

const IMEI = "ffffffff-8fbc-fbeb-8fbc-fbeb00000000";

export async function fetchRecords(
  opts: FetchRecordsOptions,
): Promise<{ ok: boolean; records: WorkoutRecord[]; error?: string; code?: number; httpStatus?:number }> {
  const base = (opts.baseUrl ?? "https://cgapp.chingo.cn/cgapp-server/").replace(/\/?$/, "/");
  const type = opts.type ?? "1";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const path = `api/l/v7/sportlist?xh=${encodeURIComponent(opts.xh)}&type=${encodeURIComponent(type)}`;

  const signer = new NativeSigner({ secret: opts.secret });
  const sig = await signer.sign({ method: "GET", signPath: `/${path}` });

  const resp = await fetchImpl(base + path, {
    method: "GET",
    headers: {
      imei: opts.session?.imei ?? IMEI,
      v1: opts.session ? buildV1() : "",
      timestamp: sig.timestamp,
      sign: sig.sign,
      cgAuthorization: opts.token,
      "User-Agent": opts.session?.userAgent ?? LOGIN_USER_AGENT,
      client: opts.session ? buildClient(opts.secret) : "",
    },
  });
  const api = (await resp.json()) as {
    code: number;
    message: string;
    data?: Array<Record<string, unknown>> | null;
  };
  if (!resp.ok || api.code !== 200 || !Array.isArray(api.data)) {
    return { ok: false, records: [], error: api.message, code: resp.ok?api.code:undefined, httpStatus:resp.status };
  }

  const records: WorkoutRecord[] = api.data.map((w) => ({
    tableName: typeof w.tableName === 'string' ? w.tableName : undefined,
    beginTime: String(w.beginTime ?? ""),
    endTime: String(w.endTime ?? ""),
    routeId: String(w.routeId ?? ""),
    sportId: String(w.sportId ?? ""),
    isValid: String(w.isValid ?? ""),
    inValidReason: String(w.isValidReason ?? w.inValidReason ?? ""),
    checkStatus: String(w.checkStatus ?? ""),
    tip: String(w.tip ?? ""),
    subType: String(w.subType ?? ""),
    odometer: String(w.odometer ?? ""),
    stepCount: String(w.stepCount ?? ""),
    avgSpeed: String(w.avgSpeed ?? ""),
    activeTime: String(w.activeTime ?? ""),
  }));
  // 最新在前
  records.sort((a, b) => b.beginTime.localeCompare(a.beginTime));
  return { ok: true, records, httpStatus:resp.status };
}
