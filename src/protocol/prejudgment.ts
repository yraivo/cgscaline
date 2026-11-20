/**
 * prejudgment 双快照（第一阶段·本地回归用）。
 *
 * 协议行为：
 *   真实客户端在运动结束时先发 prejudgment，数秒后再发 savesports，两载荷是
 *   同一 sportId 下的两个时间快照：
 *     prejudgmentSnapshot：无 coordinate、无 beganPoint/endPoint、stepCount 未定格、
 *                          minuteSpeed 含 baseObjId、endTime 为点击结束时；
 *     finalSnapshot       ：含 coordinate、beganPoint/endPoint、stepCount 定格更高、
 *                          endTime 更晚、minuteSpeed 序列化形态无 baseObjId。
 *
 * 不变式（必须满足，见 assertSnapshotInvariants）：
 *   1. 两快照 SHA-256 不同（分别序列化，不得复用密文/对象）；
 *   2. sportId 相同；
 *   3. prejudgment.endTime < savesports.endTime；
 *   4. prejudgment.stepCount <= savesports.stepCount；
 *   5. prejudgment 无 coordinate，savesports 有 coordinate。
 *
 * ⚠️ 本地构造基于当前合成 body 的字段集；真实 App 的 prejudgment 具体字段
 *    形态需第二阶段（SSL 报文 + 多场统计）校准，此模块只为受控实验提供骨架。
 */

import { createHash } from "node:crypto";

export interface PrejudgmentOptions {
  /** prejudgment 相比 final 少计的步伐数（抓包样例差 27） */
  stepDelta?: number;
  /** prejudgment 相比 final 提前的秒数（抓包样例差 8s） */
  endDeltaSec?: number;
}

const DEFAULT_STEP_DELTA = 27;
const DEFAULT_END_DELTA_SEC = 8;

/** 从 final body 派生 prejudgment 快照（深拷贝，绝不原地改 final） */
export function buildPrejudgmentSnapshot(
  finalBody: Record<string, unknown>,
  opts: PrejudgmentOptions = {},
): Record<string, unknown> {
  const stepDelta = opts.stepDelta ?? DEFAULT_STEP_DELTA;
  const endDeltaSec = opts.endDeltaSec ?? DEFAULT_END_DELTA_SEC;
  // 深拷贝：杜绝"发送前被后续状态污染"（对象复用问题）
  const snap = JSON.parse(JSON.stringify(finalBody)) as Record<string, unknown>;

  delete snap.coordinate;
  delete snap.beganPoint;
  delete snap.endPoint;

  if (typeof snap.stepCount === "number") {
    snap.stepCount = Math.max(0, snap.stepCount - stepDelta);
  } else if (typeof snap.stepCount === "string") {
    const n = Number(snap.stepCount);
    snap.stepCount = String(Math.max(0, n - stepDelta));
  }

  if (typeof snap.endTime === "string") {
    const shifted = shiftTime(snap.endTime, -endDeltaSec);
    if (shifted) snap.endTime = shifted;
  }

  // minuteSpeed 每项带 baseObjId（1 起）——抓包 prejudgment 的序列化形态
  if (Array.isArray(snap.minuteSpeed)) {
    snap.minuteSpeed = (snap.minuteSpeed as unknown[]).map((m, i) => ({
      ...(m as Record<string, unknown>),
      baseObjId: i + 1,
    }));
  }

  // stepMinute 同步按快照步数回退（保持内部自洽）
  if (typeof snap.stepCount === "number" && typeof snap.stepMinute === "string") {
    const cur = Number(snap.stepMinute);
    if (Number.isFinite(cur) && cur > 0) {
      snap.stepMinute = (cur * (1 - stepDelta / (snap.stepCount + stepDelta))).toFixed(2);
    }
  }

  return snap;
}

function shiftTime(isoLike: string, deltaSec: number): string | null {
  const m = isoLike.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}+08:00`);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + deltaSec * 1000 + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 快照不变式断言；返回失败列表（空 = 全部满足） */
export function assertSnapshotInvariants(
  prejudgment: Record<string, unknown>,
  finalBody: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  const pjSha = sha256(JSON.stringify(prejudgment));
  const fnSha = sha256(JSON.stringify(finalBody));
  if (pjSha === fnSha) errors.push("不变式 1 违反：两快照 SHA-256 相同（序列化未分离）");

  if (prejudgment.sportId !== finalBody.sportId) {
    errors.push(`不变式 2 违反：sportId 不同 (${prejudgment.sportId} vs ${finalBody.sportId})`);
  }

  const pjEnd = timeToSec(prejudgment.endTime);
  const fnEnd = timeToSec(finalBody.endTime);
  if (pjEnd != null && fnEnd != null) {
    if (!(pjEnd < fnEnd)) errors.push("不变式 3 违反：prejudgment.endTime 未早于 savesports.endTime");
  }

  const pjStep = toNum(prejudgment.stepCount);
  const fnStep = toNum(finalBody.stepCount);
  if (pjStep != null && fnStep != null) {
    if (!(pjStep <= fnStep)) errors.push("不变式 4 违反：prejudgment.stepCount 未小于等于 savesports");
  }

  const pjHasCoord = Array.isArray(prejudgment.coordinate);
  const fnHasCoord = Array.isArray(finalBody.coordinate);
  if (pjHasCoord) errors.push("不变式 5a 违反：prejudgment 不应有 coordinate");
  if (!fnHasCoord) errors.push("不变式 5b 违反：savesports 必须有 coordinate");

  return errors;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
function toNum(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function timeToSec(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}+08:00`);
  return Number.isNaN(ms) ? null : ms / 1000;
}
