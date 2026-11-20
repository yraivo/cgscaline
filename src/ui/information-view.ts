import type { AccountView } from '../app/contracts.js';
import { safeText, type Language } from '../core/model.js';
import type { InvalidReason, RecordDetail } from '../campus/information.js';
import type { WorkoutRecord } from '../protocol/records.js';
import { termPlanSummary } from '../runtime/scheduling.js';
import { recordStatus } from './task-view.js';

export { cachedInformation } from '../core/model.js';
import { cachedInformation } from '../core/model.js';

export const dateTime = (ms: number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(ms);

export function schoolLines(a: AccountView, tab = 0, lang: Language = 'zh'): string[] {
  const info = cachedInformation(a);
  if (!info?.schoolFetchedAt) {
    return [lang === 'en' ? 'No venue rules cached · press R to refresh' : '暂无学校资料缓存，按 R 刷新'];
  }
  if (tab === 0) {
    if (!info.rules.data) return [info.rules.error ?? (lang === 'en' ? 'No route rules' : '暂无路线规则')];
    return [...info.rules.data]
      .sort((x, y) => Number(y.id === a.routeId) - Number(x.id === a.routeId))
      .flatMap(r =>
        lang === 'en'
          ? [
              `${r.id === a.routeId ? '● ' : ''}${r.id}  ${r.name}${r.id === a.routeId ? '  DEFAULT' : ''}`,
              `Target ${r.distanceKm ?? '—'} km  Window ${r.minDuration || '—'}–${r.maxDuration || '—'}`,
              `IMU Sensor ${r.sensor === undefined ? '?' : r.sensor ? 'ON' : 'OFF'}  Waypoints ${r.randomPoints === undefined ? '?' : r.randomPoints ? 'ON' : 'OFF'}`,
              ...(r.faceAuth ? ['[!] Face verification enabled (unsupported — choose another route)'] : []),
              ...(r.dynamicWaypoints ? ['[!] Dynamic random checkpoints enabled (unsupported)'] : []),
              ...(r.requiredCheckpoints ? [`[!] ${r.requiredCheckpoints} mandatory checkpoint(s) configured`] : []),
              ...(r.tips ? [r.tips] : []),
              '',
            ]
          : [
              `${r.id === a.routeId ? '● ' : ''}${r.id}  ${r.name}${r.id === a.routeId ? '  默认' : ''}`,
              `合格距离 ${r.distanceKm ?? '—'} km  单次时长 ${r.minDuration || '—'}–${r.maxDuration || '—'}`,
              `传感器 ${r.sensor === undefined ? '未知' : r.sensor ? '开启' : '关闭'}  随机点 ${r.randomPoints === undefined ? '未知' : r.randomPoints ? '开启' : '关闭'}`,
              ...(r.faceAuth ? ['[!] 开启了人脸核验（暂不支持，建议切换免刷脸路线）'] : []),
              ...(r.dynamicWaypoints ? ['[!] 开启了动态随机点位（暂不支持）'] : []),
              ...(r.requiredCheckpoints ? [`[!] 含 ${r.requiredCheckpoints} 个必过打卡点（请确认样本完整经过）`] : []),
              ...(r.tips ? [r.tips] : []),
              '',
            ],
      );
  }
  if (!info.reasons.data) return [info.reasons.error ?? (lang === 'en' ? 'No invalid codes' : '暂无无效原因')];
  return [...info.reasons.data]
    .sort((x, y) => Number(x.code) - Number(y.code))
    .flatMap(r => [`${r.code}  ${r.reason}`, ...(r.description ? [r.description] : []), '']);
}

export function informationLines(a: AccountView, termTarget?: number, lang: Language = 'zh'): string[] {
  const info = cachedInformation(a);
  if (!info || !info.fetchedAt) {
    return [lang === 'en' ? 'No overview cached · press R to refresh' : '暂无概览缓存，按 R 刷新'];
  }
  const lines: string[] = [];
  const term = info.terms.data?.find(t => t.current);
  if (lang === 'en') {
    if (term) lines.push(term.name, `${term.start} — ${term.end}`, '');
    else lines.push(`Term: ${info.terms.error ?? 'Current term unavailable'}`, '');
    if (info.totals.data) lines.push('Term Credits', ...info.totals.data.map(t => `${t.label}  ${t.value} ${t.unit}`));
    else lines.push(`Term Credits: ${info.totals.error ?? 'Unavailable'}`);
    lines.push('');
    const stats = info.statistics.data;
    if (stats) {
      lines.push(
        `Valid Runs       ${stats.count}`,
        `Monthly Avg Dist ${stats.monthlyDistance || '—'} km`,
        `Monthly Avg Time ${stats.monthlyTime || '—'}`,
        ...(stats.distances.length ? [`Monthly Split    ${stats.distances.join(' / ')} km`] : []),
      );
    } else lines.push(`Statistics: ${info.statistics.error ?? 'Unavailable'}`);
    const plan = termPlanSummary(a, termTarget, Date.now(), 'en');
    if (plan && (termTarget || plan.daysLeft !== undefined)) lines.push(plan.line);
    lines.push('');
    if (info.clock.data) {
      const c = info.clock.data;
      lines.push(`Server Clock     ${dateTime(c.serverMs)}`, `Clock Skew       ${c.offsetMs >= 0 ? '+' : ''}${Math.round(c.offsetMs)} ms  RTT ${c.rttMs} ms`);
    } else lines.push(`Server Clock: ${info.clock.error ?? 'Unavailable'}`);
    lines.push('');
    if (info.terms.data) {
      lines.push(
        `Academic Terms   ${info.terms.data.length}`,
        ...info.terms.data.filter(t => !t.current).slice(0, 3).map(t => `${t.name}  ${t.start.slice(0, 10)}–${t.end.slice(0, 10)}`),
      );
    }
    return lines;
  }

  if (term) lines.push(term.name, `${term.start} — ${term.end}`, '');
  else lines.push(`学期：${info.terms.error ?? '未返回当前学期'}`, '');
  if (info.totals.data) lines.push('考核累计', ...info.totals.data.map(t => `${t.label}  ${t.value} ${t.unit}`));
  else lines.push(`考核累计：${info.totals.error ?? '暂无数据'}`);
  lines.push('');
  const stats = info.statistics.data;
  if (stats) {
    lines.push(
      `本学期有效锻炼  ${stats.count} 次`,
      `月均有效里程  ${stats.monthlyDistance || '—'} km`,
      `月均有效时长  ${stats.monthlyTime || '—'}`,
      ...(stats.distances.length ? [`各月有效里程  ${stats.distances.join(' / ')} km`] : []),
    );
  } else lines.push(`有效统计：${info.statistics.error ?? '暂无数据'}`);
  const plan = termPlanSummary(a, termTarget);
  if (plan && (termTarget || plan.daysLeft !== undefined)) lines.push(plan.line);
  lines.push('');
  if (info.clock.data) {
    const c = info.clock.data;
    lines.push(`服务器时刻  ${dateTime(c.serverMs)}`, `估计时差  ${c.offsetMs >= 0 ? '+' : ''}${Math.round(c.offsetMs)} ms  往返 ${c.rttMs} ms`);
  } else lines.push(`服务器时间：${info.clock.error ?? '暂无数据'}`);
  lines.push('');
  if (info.terms.data) {
    lines.push(
      `学期列表  ${info.terms.data.length} 个`,
      ...info.terms.data.filter(t => !t.current).slice(0, 3).map(t => `${t.name}  ${t.start.slice(0, 10)}–${t.end.slice(0, 10)}`),
    );
  }
  return lines;
}

export function informationSummary(a: AccountView, termTarget?: number, lang: Language = 'zh'): string[] {
  const info = cachedInformation(a);
  if (!info) return [];
  const term = info.terms.data?.find(t => t.current);
  const totals = info.totals.data?.map(t => `${t.label} ${t.value}${t.unit}`).join('  ');
  const plan = termTarget ? termPlanSummary(a, termTarget, Date.now(), lang) : undefined;
  if (lang === 'en') {
    return [
      ...(term ? [term.name] : []),
      ...(totals ? [`Credits · ${totals}`] : []),
      ...(info.statistics.data ? [`Valid ${info.statistics.data.count} runs · Monthly ${info.statistics.data.monthlyDistance} km`] : []),
      ...(plan ? [plan.line] : []),
    ];
  }
  return [
    ...(term ? [term.name] : []),
    ...(totals ? [`考核 · ${totals}`] : []),
    ...(info.statistics.data ? [`有效锻炼 ${info.statistics.data.count} 次 · 月均 ${info.statistics.data.monthlyDistance} km`] : []),
    ...(plan ? [plan.line] : []),
  ];
}

export function reasonLabel(code: string, reasons?: InvalidReason[]): string {
  if (!code) return '';
  return code
    .split(/[,;|，；]/)
    .map(s => {
      const v = s.trim();
      return reasons?.find(r => r.code === v)?.reason ?? v;
    })
    .join('；');
}

export function detailLines(r: WorkoutRecord, d: RecordDetail | undefined, reasons?: InvalidReason[], lang: Language = 'zh'): string[] {
  if (lang === 'en') {
    return [
      `${r.beginTime} — ${r.endTime || '—'}`,
      `Route ${r.routeId}  ${r.odometer} km  ${r.activeTime || '—'}`,
      recordStatus(r, 'en'),
      ...(r.tip ? [safeText(r.tip)] : []),
      ...(r.inValidReason ? [`Reason: ${reasonLabel(r.inValidReason, reasons)}`] : []),
      '',
      ...(d
        ? [
            `Track Points   ${d.coordinateCount ?? '—'}`,
            `Route Segments ${d.routeCount ?? '—'}`,
            `Minute Splits  ${d.minuteCount ?? '—'}`,
            `IMU Payload    ${d.sensorReturned ? 'Present' : 'Empty'}`,
            '',
            `Cached ${dateTime(d.fetchedAt)}`,
          ]
        : ['No detail cached', 'Press R to fetch trajectory & IMU detail']),
    ];
  }
  return [
    `${r.beginTime} — ${r.endTime || '—'}`,
    `路线 ${r.routeId}  ${r.odometer} km  ${r.activeTime || '—'}`,
    recordStatus(r),
    ...(r.tip ? [safeText(r.tip)] : []),
    ...(r.inValidReason ? [`原因 ${reasonLabel(r.inValidReason, reasons)}`] : []),
    '',
    ...(d
      ? [
          `轨迹点  ${d.coordinateCount ?? '未识别'}`,
          `路线段  ${d.routeCount ?? '未识别'}`,
          `分钟速度  ${d.minuteCount ?? '未识别'}`,
          `传感器文件  ${d.sensorReturned ? '字段非空' : '未返回'}`,
          '',
          `缓存 ${dateTime(d.fetchedAt)}`,
        ]
      : ['暂无详情缓存', '按 R 读取轨迹与传感器详情']),
  ];
}
