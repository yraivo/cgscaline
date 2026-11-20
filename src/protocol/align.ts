/**
 * 时间对齐（提交瞬间调用）——单一事实源（从 viewer SubmitPanel 移入，统一时区模型）。
 *
 * 依据（原生协议对照）：
 * - 官方客户端在运动结束立即保存（秒级），body 的 endTime ≈ 提交时刻；
 * - 原生 body 的时间字符串与 coordinate epoch 使用设备时区；
 * - 同一设备身份不得在相邻会话切换时区表示 → 时区由调用方显式传入，
 *   默认 0（UTC，对齐当前 VM），不要隐式用宿主机时区。
 *
 * 只平移 coordinate 的 t（非零值平移，t=0 初始化点保持 0）并重写
 * beginTime/endTime 字符串；activeTime/minuteSpeed/pace 等相对量不动。
 */

/** 兼容最小 body 形状（UploadJsonSports 子集；不含 index signature 以便接口直接赋值） */
export interface AlignableBody {
  beginTime?: string;
  endTime?: string;
  coordinate?: Array<{ t: number }>;
}

export interface AlignOptions {
  /** endTime = now - offsetSec（官方=运动结束立即保存，秒级延迟） */
  offsetSec?: number;
  /** 设备时区偏移（分钟）；默认 0 = UTC（当前 VM 实测）；中国东八区传 480 */
  timezoneOffsetMin?: number;
  /**
   * 首个采样间隔（= init 哨兵点 → 首正点），默认 2000ms。
   * C 路线（2026-08-03 定稿）：beginTime 锚定在运动起点（= 首正 t − intervalMs），
   * 使首段 [beginTime, 首正点] 获得真实时间归属——首段 d/st 不再挂在零耗时上。
   */
  sampleIntervalMs?: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** epoch ms → 设备时区的 "yyyy-MM-dd HH:mm:ss"（与原生 body 字符串一致） */
export function formatDeviceTime(ms: number, timezoneOffsetMin: number): string {
  const shifted = new Date(ms + timezoneOffsetMin * 60 * 1000);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/**
 * 把 body 的 begin/end 与 coordinate t 对齐到"刚结束"（end = now - offsetSec）。
 *
 * ★ C 路线语义（2026-08-03 定稿，替代旧"首正 t 锚整秒"）：
 *   init 哨兵点保持 t=0（原生保留字段），但 beginTime 不再等于首正点，
 *   而是 = 首正 t − intervalMs（运动起点）。首段位移 d/st 归属 [beginTime, 首正 t]。
 *
 * ⚠️ 必须在 GET sportsId 之后调用：保证 beginTime 晚于 sportId 签发（原生生命周期
 * = 运动开始前先取 sportId，签发时刻早于运动窗口）。
 * 泛型保留原 body 具体类型（UploadJsonSports 等）。
 */
export function alignBodyToNow<T extends AlignableBody>(
  body: T,
  opts: AlignOptions = {},
): T {
  return alignBodyToTarget(body, Date.now() - (opts.offsetSec ?? 10) * 1000, opts);
}

/**
 * ★ 2026-08-05 新增：把 body 时间窗对齐到**指定结束时刻**（预定发布核心）。
 *
 * 预定发布语义（inSportTime 生命周期）：
 *   T1 = inSportTime 请求时刻（服务端记录"运动开始"）
 *   T2 = T1 + 轨迹时长（运动结束）
 *   → 提交时 body 的 beginTime=T1、endTime=T2，coordinate t 平移对齐。
 *
 * 与 alignBodyToNow 同算法，只是锚点从"现在"换成调用方指定的 targetEndMs。
 * 必须保证：targetEndMs - 时长 > inSportTime 时刻（运动开始晚于服务端记录）。
 */
export function alignBodyToTarget<T extends AlignableBody>(
  body: T,
  targetEndMs: number,
  opts: AlignOptions = {},
): T {
  // ★ 2026-08-25 清理：删除未使用的 offsetSec（锚点已由 targetEndMs 指定，
  //   offsetSec 仅在 alignBodyToNow 中生效，此处读取纯属误导）
  const tzMin = opts.timezoneOffsetMin ?? 0;
  const intervalMs = opts.sampleIntervalMs ?? 2000;
  const coords = Array.isArray(body.coordinate) ? body.coordinate : [];
  const ts = coords.map((c) => c.t).filter((t) => t && t > 0);
  if (ts.length === 0) return { ...body };

  const durationMs = Math.max(...ts) - Math.min(...ts);
  const newEnd = targetEndMs;
  // ★ C 路线：beginTime = 运动起点 = 首正点 − intervalMs，整秒归位保证首段尾数 .000。
  const newStart = Math.floor((newEnd - durationMs - intervalMs) / 1000) * 1000;
  const shift = newStart - (Math.min(...ts) - intervalMs);

  return {
    ...body,
    beginTime: formatDeviceTime(newStart, tzMin),
    endTime: formatDeviceTime(newEnd, tzMin),
    coordinate: coords.map((c) => ({ ...c, t: c.t === 0 ? 0 : c.t + shift })),
  } as T;
}
