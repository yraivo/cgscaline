import type { TaskView, AppState, AccountView } from '../app/contracts.js';
import { cachedInformation, type Account, type Language, type Task } from '../core/model.js';
import type { InvalidReason } from '../campus/information.js';
import { geometryWarnings } from '../track/geometry.js';
import { maskFixed, maskText } from '../core/privacy.js';

type AnyTask = Task | TaskView;
type StateLike = Pick<AppState, 'accounts'> & { settings?: { privacyMode?: boolean; language?: Language } };

export const visibleTasks = <T extends AnyTask>(state: { tasks: readonly T[] }, history = false) => state.tasks.filter(t => history ?
  !!(t.session || t.result || t.steps?.length || t.phase === 'review' || t.phase === 'done') : !['done', 'abandoned'].includes(t.phase));

export const taskAccountLabel = (task: AnyTask, state?: StateLike, privacy?: boolean) => {
  const raw = state?.accounts.find(a => a.id === task.accountId)?.label ?? task.accountLabel;
  return (privacy ?? state?.settings?.privacyMode) ? maskText(raw) : raw;
};

export const taskPhaseNames = { queued: '待开始', starting: '正在开始', waiting: '进行中', committing: '正在提交', paused: '已暂停', review: '待核对', done: '已提交', abandoned: '已归档' } as const;
export const taskPhaseNamesEn = { queued: 'Queued', starting: 'Starting', waiting: 'Running', committing: 'Committing', paused: 'Paused', review: 'Verify', done: 'Committed', abandoned: 'Archived' } as const;

export function recordStatus(record: { isValid?: string; checkStatus?: string; inValidReason?: string; reason?: string }, lang: Language = 'zh') {
  const reason = record.inValidReason ?? record.reason;
  if (lang === 'en') {
    if (record.checkStatus === '0') return 'Pending Review';
    if (record.isValid === '1' && record.checkStatus === '1' && !reason) return 'Valid';
    if (['0', '-1'].includes(record.isValid ?? '') || reason) return 'Invalid';
    return 'Submitted';
  }
  if (record.checkStatus === '0') return '待审核';
  if (record.isValid === '1' && record.checkStatus === '1' && !reason) return '已通过';
  if (['0', '-1'].includes(record.isValid ?? '') || reason) return '未通过';
  return '已提交';
}

export type TaskCheck = { kind: 'result'; audit: NonNullable<Task['audit']> } | { kind: 'error'; message: string };
export const taskSportId = (task: AnyTask) => task.session?.sportId || task.result?.sportId;

export function auditResultLabel(audit: Task['audit'], lang: Language = 'zh') {
  if (!audit) return lang === 'en' ? 'Unverified' : '未核对';
  if (!audit.found) return lang === 'en' ? 'Not found in latest query' : '本次查询未找到';
  return audit.record ? recordStatus(audit.record, lang) : (lang === 'en' ? 'Unrecognized status' : '记录状态未识别');
}

export const auditLabel = (task: AnyTask, lang: Language = 'zh') => auditResultLabel(task.audit, lang);
const cachedAuditLabel = (audit: Task['audit'], lang: Language = 'zh') =>
  audit?.found === false ? (lang === 'en' ? 'Not found in previous query' : '上次查询未找到') : auditResultLabel(audit, lang);
export const taskCheckLabel = (check: TaskCheck, lang: Language = 'zh') =>
  check.kind === 'result' ? auditResultLabel(check.audit, lang) : check.message;

function formatReason(code: string, reasons?: InvalidReason[]): string {
  if (!code) return '';
  return code.split(/[,;|，；]/).map(s => {
    const v = s.trim();
    return reasons?.find(r => r.code === v)?.reason ?? v;
  }).join('；');
}

export function taskSummary(task: AnyTask, check?: TaskCheck, lang: Language = 'zh') {
  if (check?.kind === 'error') return check.message;
  if (lang === 'en') {
    if (task.phase === 'done') {
      if (check?.kind === 'result') return `Committed · ${auditResultLabel(check.audit, 'en')}`;
      if (task.audit) return `Committed · ${cachedAuditLabel(task.audit, 'en')}`;
      const status = task.result?.businessValid ? 'Valid' : recordStatus(task.result ?? {}, 'en');
      return status === 'Submitted' ? 'Committed' : `Committed · ${status}`;
    }
    if (task.phase === 'queued') return 'Awaiting start window';
    if (task.phase === 'starting') return 'Initializing session';
    if (task.phase === 'waiting') return 'In progress · awaiting commit';
    if (task.phase === 'committing') return 'Uploading telemetry';
    if (task.phase === 'paused') return task.resumePhase === 'queued' ? 'Schedule paused' : 'Session paused';
    if (task.phase === 'abandoned') return 'Archived';
    if (check?.kind === 'result') return `Audit · ${auditResultLabel(check.audit, 'en')}`;
    if (task.audit?.found) return `Audit · ${cachedAuditLabel(task.audit, 'en')}`;
    return taskSportId(task) ? 'Interrupted · press C to verify' : 'Interrupted · no sportId allocated';
  }
  if (task.phase === 'done') {
    if (check?.kind === 'result') return `提交成功 · ${auditResultLabel(check.audit)}`;
    if (task.audit) return `提交成功 · ${cachedAuditLabel(task.audit)}`;
    const status = task.result?.businessValid ? '已通过' : recordStatus(task.result ?? {});
    return status === '已提交' ? '提交成功' : `提交成功 · ${status}`;
  }
  if (task.phase === 'queued') return '等待开始';
  if (task.phase === 'starting') return '正在开始';
  if (task.phase === 'waiting') return '等待提交';
  if (task.phase === 'committing') return '正在提交';
  if (task.phase === 'paused') return task.resumePhase === 'queued' ? '计划已暂停' : '任务已暂停';
  if (task.phase === 'abandoned') return '已归档';
  if (check?.kind === 'result') return `核对结果 · ${auditResultLabel(check.audit)}`;
  if (task.audit?.found) return `核对结果 · ${cachedAuditLabel(task.audit)}`;
  const next = taskSportId(task) ? '结果待核对' : '没有运动编号，可到“我的记录”查看';
  const note = (task.note ?? '').replace(/ · 可能部分完成.*$/, '').replace(/；未自动重试。?$/, '')
    .replace(/按\s*C\s*(?:查看(?:结果|记录)|(?:刷新)?核对(?:结果|记录)?)/gi, next);
  return !taskSportId(task) && !note.includes(next) ? `${note || '任务中断'} · ${next}` : note || `任务中断，${next}。`;
}

export function taskLines(task: AnyTask, state?: StateLike, check?: TaskCheck, privacy?: boolean, lang?: Language) {
  const resolvedLang: Language = lang ?? state?.settings?.language ?? 'zh';
  const isPrivate = privacy ?? state?.settings?.privacyMode ?? false;
  const account = state?.accounts.find(a => a.id === task.accountId) as (Account | AccountView | undefined);
  const reasons = account ? cachedInformation(account)?.reasons.data : undefined;
  const audit = check?.kind === 'result' ? check.audit : check?.kind === 'error' ? undefined : task.audit;
  const r = audit?.found ? audit.record : undefined;
  const sid = taskSportId(task);
  if (resolvedLang === 'en') {
    return [
      `${taskAccountLabel(task, state, isPrivate)} · ${taskPhaseNamesEn[task.phase]}`,
      taskSummary(task, check, 'en'),
      `${task.prepared.body.odometer} km · ${Math.round(task.prepared.durationSec)} s · Route ${task.prepared.routeId}`,
      ...(task.prepared.previewWarnings ?? ('kind' in task.prepared ? task.prepared.previewWarnings : geometryWarnings(task.prepared))).map(v => `Geometry note: ${v}`),
      ...(task.steps ?? []).map(s => `${s.endpoint}  HTTP ${s.httpStatus}  Code ${s.code ?? '?'}`),
      ...(task.result ? [`Initial verdict: ${recordStatus(task.result, 'en')}`, ...(task.result.reason ? [`Reason: ${formatReason(task.result.reason, reasons)}`] : [])] : []),
      `Sport ID: ${sid ? (isPrivate ? maskFixed(sid, 12) : sid) : '—'}`,
      '',
      `Log audit: ${check?.kind === 'error' ? 'Failed' : check?.kind === 'result' ? auditResultLabel(audit, 'en') : cachedAuditLabel(audit, 'en')}`,
      ...(audit ? [`Verified at: ${new Date(audit.checkedAt).toLocaleString('en-US', { hour12: false })}`] : []),
      ...(r ? [
        `Server record: ${r.beginTime} · ${r.odometer} km · ${r.activeTime}`,
        ...(r.inValidReason ? [`Invalid reason: ${formatReason(r.inValidReason, reasons)}`] : []),
        ...(r.tip ? [r.tip] : []),
      ] : []),
    ];
  }
  return [
    `${taskAccountLabel(task, state, isPrivate)} · ${taskPhaseNames[task.phase]}`,
    taskSummary(task, check),
    `${task.prepared.body.odometer} km · ${Math.round(task.prepared.durationSec)} s · 路线 ${task.prepared.routeId}`,
    ...(task.prepared.previewWarnings ?? ('kind' in task.prepared ? task.prepared.previewWarnings : geometryWarnings(task.prepared))).map(v => `轨迹提示：${v}`),
    ...(task.steps ?? []).map(s => `${s.endpoint}  HTTP ${s.httpStatus}  返回码 ${s.code ?? '未知'}`),
    ...(task.result ? [`提交初判：${recordStatus(task.result)}`, ...(task.result.reason ? [`原因：${formatReason(task.result.reason, reasons)}`] : [])] : []),
    `运动编号：${sid ? (isPrivate ? maskFixed(sid, 12) : sid) : '—'}`,
    '',
    `列表核对：${check?.kind === 'error' ? '核对失败' : check?.kind === 'result' ? auditResultLabel(audit) : cachedAuditLabel(audit)}`,
    ...(audit ? [`核对时间：${new Date(audit.checkedAt).toLocaleString('zh-CN')}`] : []),
    ...(r ? [
      `平台记录：${r.beginTime} · ${r.odometer} km · ${r.activeTime}`,
      ...(r.inValidReason ? [`未通过原因：${formatReason(r.inValidReason, reasons)}`] : []),
      ...(r.tip ? [r.tip] : []),
    ] : []),
  ];
}
