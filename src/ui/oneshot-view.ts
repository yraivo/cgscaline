import type { PreparedSummary } from '../app/contracts.js';
import type { Language, Prepared } from '../core/model.js';
import { durationText } from '../track/fit.js';
import { geometryErrors, geometryWarnings } from '../track/geometry.js';

export function oneShotLines(p: Prepared | PreparedSummary, lang: Language = 'zh'): string[] {
  const coordCnt = 'kind' in p ? p.coordinateCount : p.body.coordinate?.length ?? 0;
  const sensorCnt = 'kind' in p ? p.sensorSampleCount : p.sensorSampleCount ?? p.sensor.length;
  const vErrs = 'kind' in p ? p.validationErrors : geometryErrors(p);
  const warns = 'kind' in p ? p.previewWarnings : geometryWarnings(p);
  if (lang === 'en') {
    return [
      `${p.body.odometer} km · ${durationText(p.durationSec)} · ${p.body.avgPace || '—'}/km`,
      `Route ${p.routeId} · ${p.targets ? 'Custom Fit' : p.generation === 'auto' ? 'Auto Corridor Fit' : 'Raw Replay'}`,
      ...(p.targets
        ? [
            `Target ${p.targets.distanceKm === undefined ? 'Auto Dist' : `${p.targets.distanceKm.toFixed(2)} km`} / ${p.targets.durationSec === undefined ? 'Auto Time' : durationText(p.targets.durationSec)}`,
          ]
        : []),
      '',
      `Source #${p.sourceRunId} · Pool ${p.candidateCount ?? '—'} · seed ${p.seed}`,
      `Original ${p.sourceDistanceKm?.toFixed(2) ?? '—'} km / ${p.sourceDurationSec === undefined ? '—' : durationText(p.sourceDurationSec)}`,
      ...(p.rawGeometryCoverage ? [p.rawGeometryCoverage === 'partial' ? 'GPS distance excludes gaps' : 'No adjacent valid GPS fixes'] : []),
      ...(p.rawGeometryMeters === undefined ? [] : [`Original GPS (adjacent valid fixes) ${Math.round(p.rawGeometryMeters)} m`]),
      `GNSS ${coordCnt} pts · ${p.sensorSource === 'recorded' ? 'Recorded IMU' : 'Synthesized IMU'} ${sensorCnt} pts`,
      ...(p.fit ? [`Cadence Scale ×${p.fit.timeScale.toFixed(3)}`] : []),
      `Auto-commit in ~${durationText(p.durationSec + 5)}`,
      ...vErrs.map(s => `Blocked: ${s}`),
      ...warns.map(s => `Note: ${s}`),
    ];
  }
  return [
    `${p.body.odometer} km · ${durationText(p.durationSec)} · ${p.body.avgPace || '—'}/km`,
    `路线 ${p.routeId} · ${p.targets ? '自定义拟合' : p.generation === 'auto' ? '自动拟合' : '默认采样'}`,
    ...(p.targets
      ? [
          `目标 ${p.targets.distanceKm === undefined ? '距离随样本' : `${p.targets.distanceKm.toFixed(2)} km`} / ${p.targets.durationSec === undefined ? '时长随样本' : durationText(p.targets.durationSec)}`,
        ]
      : []),
    '',
    ...(p.rawGeometryCoverage ? [p.rawGeometryCoverage === 'partial' ? 'GPS 里程已排除缺测段' : '缺少相邻有效定位点'] : []),
    `来源 #${p.sourceRunId} · 可用 ${p.candidateCount ?? '—'} 条 · seed ${p.seed}`,
    ...(p.rawGeometryMeters === undefined ? [] : [`原始 GPS（相邻有效点）${Math.round(p.rawGeometryMeters)} 米`]),
    `原记录 ${p.sourceDistanceKm?.toFixed(2) ?? '—'} km / ${p.sourceDurationSec === undefined ? '—' : durationText(p.sourceDurationSec)}`,
    `坐标 ${coordCnt} 点 · ${p.sensorSource === 'recorded' ? '历史传感器' : '生成传感器'} ${sensorCnt} 点`,
    ...(p.fit ? [`节奏 ×${p.fit.timeScale.toFixed(3)}`] : []),
    `预计 ${durationText(p.durationSec + 5)} 后提交`,
    ...vErrs.map(s => `未通过：${s}`),
    ...warns.map(s => `提示：${s}`),
  ];
}
