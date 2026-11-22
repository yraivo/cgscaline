import { distanceMeters } from './geo.js';
import { UserError, type Prepared } from '../core/model.js';

/** GPS 短时速度峰值只提示；字段非法、逆序位移和距离膨胀继续阻止执行。 */
function review(p: Prepared) {
  const errors: string[] = [], warnings: string[] = [], points = p.body.coordinate ?? [];
  if (!points.length || points.some(v => ![v.a,v.o,v.t].every(Number.isFinite) || Math.abs(v.a)>90 || Math.abs(v.o)>180))
    errors.push('坐标或时间字段为空、非有限值或越界');
  let peak = 0;
  let geoV1 = 0;
  let geoDPos = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i-1]!, b = points[i]!;
    if ([a.a, a.o, b.a, b.o].every(Number.isFinite)) {
      const stepDist = distanceMeters([a.a, a.o], [b.a, b.o]);
      if (b.v === 1) geoV1 += stepDist;
      if ((b.d ?? 0) > 0) geoDPos += stepDist;
      if (a.t > 0 && b.t > 0 && a.v === 1 && b.v === 1) {
        const dt = b.t - a.t;
        if (dt <= 0 && stepDist > 5) { errors.push('相同/逆序时间点存在明显位移'); break; }
        if (dt > 0) peak = Math.max(peak, stepDist / dt * 3600);
      }
    }
  }
  if (peak > 50) warnings.push(`速度峰值 ${peak.toFixed(1)} km/h`);
  const km = Number(p.body.odometer);
  if (!Number.isFinite(km) || km<=0) errors.push('里程字段非法');
  const daLast = points.at(-1)?.da ?? 0;
  if (points.length >= 20 && daLast > 0 && daLast - geoDPos > 20) {
    errors.push('累计里程高于坐标真实几何位移');
  }
  if (points.length >= 20 && km >= 3 && geoV1 < 3005) {
    errors.push('有效轨迹坐标几何总长不足 3.00 km');
  }
  if (p.sourceDistanceKm && Math.abs(km/p.sourceDistanceKm-1) > .15) errors.push('生成距离相对来源变化超过 15%');
  return { errors, warnings };
}
export const geometryErrors = (p: Prepared): string[] => review(p).errors;
export const geometryWarnings = (p: Prepared): string[] => review(p).warnings;
/** 诊断报告保留所有问题；是否阻止执行应使用 geometryErrors。 */
export const geometryIssues = (p: Prepared): string[] => { const r=review(p);return [...r.errors,...r.warnings]; };
export function assertGeometry(p: Prepared) {
  const issues = geometryErrors(p);
  if (issues.length) throw new UserError(`轨迹数据有误：${issues.join('；')}。`);
}
