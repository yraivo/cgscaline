/**
 * 提交前 invariant validator —— 本地阻止自相矛盾的数据进入网络路径。
 *
 * 依据（2026-08-03 原生抓包对照审计）：
 * - activeTime 不得大于 endTime - beginTime（构造曾多 2 秒）；
 * - lastOdometerTime：0km 为 ""（原生 0km body），有距离时为末段用时（非整公里），
 *   不得硬编码 "00:00:00"；
 * - minuteSpeed 数量 = floor(activeTimeSec/60)（原生 131s→2 项、1127s→18 项；
 *   构造曾用 ceil 多出一项）；
 * - 首点 t=0 是初始化点：ac=0、v=0、s=0（原生首点同值；不是 ac<=30→v=1）；
 * - sportId 必须是本次会话 GET sportsId 的签发值（MOCK 占位 / 空 = 未注入）；
 * - sensor 样本数 ≈ 10Hz × 坐标时间窗（±5s）；
 * - odometer 与末点 da、stepCount 与末点 sta 必须同源一致。
 */

export interface ValidateOptions {
  /** preview 模式允许占位 sportId（"" / MOCK-*），submit 必须为签发值 */
  allowPlaceholderSportId?: boolean;
  /** sensor 样本数（有则校验 10Hz×窗匹配） */
  sensorSampleCount?: number;
}

interface BodyLike {
  coordinate?: Array<{
    t: number;
    da?: number;
    sta?: number;
    ac?: number;
    s?: number;
    v?: number;
  }>;
  activeTime?: string;
  beginTime?: string;
  endTime?: string;
  sportId?: string;
  odometer?: string | number;
  stepCount?: string | number;
  minuteSpeed?: unknown[];
  lastOdometerTime?: string;
  [k: string]: unknown;
}

/** "HH:MM:SS" / "MM:SS" → 秒；解析失败返回 null */
function parseHms(value: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const mi = Number(m[2]);
  const s = Number(m[3]);
  if (mi > 59 || s > 59) return null;
  return h * 3600 + mi * 60 + s;
}

/** "yyyy-MM-dd HH:mm:ss"（东八区墙钟）→ epoch ms；解析失败返回 null
 *  ★ 2026-08-25 修复：原按 UTC 语义解析（Date.UTC），与 coordinate.t（真实 epoch）
 *    交叉比较会差 8h。改 +08:00 语义后差值计算结果不变，且可直接与 epoch 比较。 */
function parseDateStr(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  return Number.isNaN(ms) ? null : ms;
}

function windowSec(body: BodyLike): number | null {
  const coords = Array.isArray(body.coordinate) ? body.coordinate : [];
  const ts = coords.map((c) => c.t).filter((t) => t && t > 0);
  if (ts.length === 0) return null;
  return (Math.max(...ts) - Math.min(...ts)) / 1000;
}

export function validateSaveJson(body: unknown, opts: ValidateOptions = {}): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") {
    return ["body 不是对象"];
  }
  const b = body as BodyLike;

  const coords = Array.isArray(b.coordinate) ? b.coordinate : [];
  if (coords.length === 0) {
    errors.push("coordinate 为空");
  } else {
    // 首点 t=0 初始化点状态（原生：ac=0, v=0, s=0）
    const first = coords[0]!;
    if (first.t !== 0) errors.push(`首点 t 应为 0（初始化点），实际 ${first.t}`);
    if (first.ac !== 0) errors.push(`首点 ac 应为 0（原生初始化点），实际 ${first.ac}`);
    if (first.v !== 0) errors.push(`首点 v 应为 0（原生初始化点），实际 ${first.v}`);
    if (first.s !== 0) errors.push(`首点 s 应为 0（原生初始化点），实际 ${first.s}`);

    const last = coords[coords.length - 1]!;
    const odometerKm = Number(b.odometer ?? "0");
    const daLast = last.da;
    if (typeof daLast === "number" && odometerKm > 0 && daLast > 0) {
      // 两位小数 km 表示 → 最大舍入误差 5m（如 da=3142.4m → odometer="3.14"km）
      if (Math.abs(odometerKm * 1000 - daLast) > 5) {
        errors.push(
          `odometer=${odometerKm}km 与末点 da=${daLast}m 不一致（差 ${Math.abs(odometerKm * 1000 - daLast).toFixed(1)}m）`,
        );
      }
    }
    const stepCount = Number(b.stepCount ?? "0");
    const staLast = last.sta;
    if (typeof staLast === "number" && stepCount > 0 && staLast > 0) {
      // ★ 2026-08-06 放宽：真实 51 条有效记录 stepCount−末点 sta 差分布 +2~+24
      //   （5dd4ca4c: 2427 vs 2403 = +24；+4 常见）——服务端当年全接受，
      //   ≤2 是合成自洽保护，replay 真实记录必超。容差取真实 max 上限 30。
      if (Math.abs(stepCount - staLast) > 30) {
        errors.push(`stepCount=${stepCount} 与末点 sta=${staLast} 不一致`);
      }
    }
  }

  // activeTime ≤ 坐标时间窗 + 容差（2026-08-05 修正：真实 51 条记录 dltime−窗 分布
  //   med=-0.1s、max=+6.5s——App 独立计时器与 GPS 窗有天然差，+1s 容差过紧）
  const wSec = windowSec(b);
  const activeSec = typeof b.activeTime === "string" ? parseHms(b.activeTime) : null;
  if (activeSec === null) {
    errors.push(`activeTime 非法：${String(b.activeTime)}`);
  } else if (wSec !== null && activeSec > wSec + 10) {
    errors.push(`activeTime=${activeSec}s 大于坐标时间窗=${wSec.toFixed(1)}s`);
  }

  // beginTime/endTime 跨度与窗一致
  if (typeof b.beginTime === "string" && typeof b.endTime === "string") {
    const s = parseDateStr(b.beginTime);
    const e = parseDateStr(b.endTime);
    if (s !== null && e !== null) {
      const span = (e - s) / 1000;
      if (wSec !== null && Math.abs(span - wSec) > 3) {
        errors.push(`beginTime→endTime 跨度 ${span.toFixed(1)}s 与坐标窗 ${wSec.toFixed(1)}s 不一致`);
      }
      if (span <= 0) errors.push("beginTime ≥ endTime");
    }
  }

  // minuteSpeed 数量 = floor(activeTime/60)（原生规则；ceil 多出项是构造 bug）
  if (Array.isArray(b.minuteSpeed) && activeSec !== null) {
    const expected = Math.floor(activeSec / 60);
    if (b.minuteSpeed.length !== expected) {
      errors.push(`minuteSpeed=${b.minuteSpeed.length} 项，应为 floor(activeTime/60)=${expected}`);
    }
  }

  // lastOdometerTime：0km → ""；有距离 → 非全零的 HH:MM:SS
  const odometerKm = Number(b.odometer ?? "0");
  if (odometerKm <= 0) {
    if (b.lastOdometerTime !== "" && b.lastOdometerTime !== undefined) {
      errors.push(`odometer=0 时 lastOdometerTime 应为 ""（原生 0km body），实际 "${b.lastOdometerTime}"`);
    }
  } else {
    const lot = b.lastOdometerTime;
    if (typeof lot !== "string" || lot === "" || lot === "00:00:00") {
      errors.push(`lastOdometerTime 缺失/为零（odometer=${odometerKm}km 时应为末段用时）`);
    }
  }

  // sportId 注入检查：submit 必须非空（= 本次会话 GET sportsId 的签发值）；
  // preview 必须空串占位。★ 不以前缀判断"是否注入"（mock 服务端也可能签发 UUID）。
  const sid = b.sportId ?? "";
  if (opts.allowPlaceholderSportId) {
    if (sid !== "") {
      errors.push(`preview 模式下 sportId 应为占位（空串），实际 "${sid}"`);
    }
  } else if (!sid) {
    errors.push("sportId 未注入（空）——必须是本次会话 GET sportsId 的签发值");
  }

  // sensor 10Hz × 时长匹配（★ 2026-08-29 修正：真实运动存在暂停，sensor 样本数对齐 activeTime，
  //   而不是包含暂停的 GPS 墙钟坐标窗 wSec；上限不得超过坐标窗 + 容差，与 activeTime 或 wSec 之一相符即可）
  if (opts.sensorSampleCount !== undefined && opts.sensorSampleCount > 0) {
    const actual = opts.sensorSampleCount / 10;
    const refSec = activeSec ?? wSec;
    if (wSec !== null && actual > wSec + 15) {
      errors.push(`sensor 时长 ${actual.toFixed(1)}s 大于坐标时间窗 ${wSec.toFixed(1)}s`);
    } else if (
      refSec !== null &&
      Math.abs(actual - refSec) > Math.max(60, refSec * 0.1) &&
      (wSec === null || Math.abs(actual - wSec) > Math.max(60, wSec * 0.1))
    ) {
      errors.push(
        `sensor 时长 ${actual.toFixed(1)}s 与运动时长 ${refSec.toFixed(1)}s / 坐标窗偏差过大`,
      );
    }
  }

  return errors;
}
