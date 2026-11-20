import type { ColorTheme, Compatibility, Language, State, TaskPhase } from './model.js';

const requests = {
  version: '版本探测', login: '密码登录', issue: '会话续期', sportlist: '运动记录', currentTimeMillis: '服务器时间',
  termlist: '学期列表', termSportTotal: '考核累计', statistics: '有效统计', sporttype: '路线规则', invalidconf: '无效原因',
  activity: '学校公告', notifications: '学校通知',
  detail: '运动详情', inSportTime: '运动开始', sportsId: '申请运动编号', prejudgment: '运动预审', savesports: '提交运动', sensorZipFile: '上传传感器',
} as const;
const requestsEn: Record<keyof typeof requests, string> = {
  version: 'Version probe', login: 'Password auth', issue: 'Token renew', sportlist: 'Workout list', currentTimeMillis: 'Server clock',
  termlist: 'Term list', termSportTotal: 'Term credits', statistics: 'Valid stats', sporttype: 'Route rules', invalidconf: 'Invalid codes',
  activity: 'Campus bulletin', notifications: 'Campus ticker',
  detail: 'Track detail', inSportTime: 'Session start', sportsId: 'Alloc sportId', prejudgment: 'Pre-commit', savesports: 'Commit run', sensorZipFile: 'Upload IMU',
};
export type RequestName = keyof typeof requests;
export type ActivityCode = 'startup' | 'sessions' | 'compatibility' | 'request' | 'request-error' | 'account-added' | 'account-deleted'
  | 'profile' | 'session-saved' | 'session-cleared' | 'records' | 'information' | 'school-information' | 'school-notices' | 'appearance' | 'detail' | 'plan' | 'task' | 'theme' | 'operation-stopped';
export interface ActivityEntry {
  at: number; code: ActivityCode; level: 'info' | 'ok' | 'warn' | 'error'; accountId?: string;
  request?: RequestName; status?: number; count?: number; compatibility?: Compatibility['status']; phase?: TaskPhase; theme?: ColorTheme;
}
type ActivityOptions = Partial<Omit<ActivityEntry, 'at' | 'code'>>;
export const ACTIVITY_LIMIT = 80;
const codes = new Set<ActivityCode>(['startup', 'sessions', 'compatibility', 'request', 'request-error', 'account-added', 'account-deleted',
  'profile', 'session-saved', 'session-cleared', 'records', 'information', 'school-information', 'school-notices', 'appearance', 'detail', 'plan', 'task', 'theme', 'operation-stopped']);
const phases: Record<TaskPhase, string> = { queued: '未开始', starting: '正在开始', waiting: '进行中', committing: '正在提交', paused: '已暂停', review: '待核对', done: '已提交', abandoned: '已归档' };
const phasesEn: Record<TaskPhase, string> = { queued: 'Queued', starting: 'Starting', waiting: 'Running', committing: 'Committing', paused: 'Paused', review: 'Verify', done: 'Committed', abandoned: 'Archived' };
function normalize(raw: unknown): ActivityEntry | undefined {
  if (!raw || typeof raw !== 'object') return;
  const v = raw as ActivityEntry;
  if (!codes.has(v.code) || !Number.isFinite(v.at) || v.at < 0) return;
  const entry: ActivityEntry = { at: v.at, code: v.code, level: ['info', 'ok', 'warn', 'error'].includes(v.level) ? v.level : 'info' };
  if (typeof v.accountId === 'string' && /^[a-f\d-]{36}$/i.test(v.accountId)) entry.accountId = v.accountId;
  if (typeof v.request === 'string' && Object.hasOwn(requests, v.request)) entry.request = v.request;
  if (Number.isInteger(v.status) && v.status! >= 100 && v.status! <= 599) entry.status = v.status;
  if (Number.isInteger(v.count) && v.count! >= 0 && v.count! <= 10_000_000) entry.count = v.count;
  if (v.compatibility && ['ok', 'unknown', 'update'].includes(v.compatibility)) entry.compatibility = v.compatibility;
  if (typeof v.phase === 'string' && Object.hasOwn(phases, v.phase)) entry.phase = v.phase;
  if (v.theme === 'astolfo' || v.theme === 'spectrum' || v.theme === 'mescaline' || v.theme === 'acid') entry.theme = v.theme;
  return entry;
}
/** 只接受枚举和数值元数据；不接收 URL、自由文本、凭据、请求头或响应正文。 */
export function recordActivity(state: State, code: ActivityCode, options: ActivityOptions = {}) {
  const entry = normalize({
    at: Date.now(), code, level: options.level, accountId: options.accountId, request: options.request,
    status: options.status, count: options.count, compatibility: options.compatibility, phase: options.phase, theme: options.theme,
  });
  if (!entry) return;
  state.activity = [...(Array.isArray(state.activity) ? state.activity.slice(-ACTIVITY_LIMIT).map(normalize).filter((v): v is ActivityEntry => !!v) : []), entry].slice(-ACTIVITY_LIMIT);
}
export function recentActivity(state: Pick<State, 'activity'>, accountId?: string, limit = 6): ActivityEntry[] {
  const size = Math.max(0, Math.floor(limit)); if (!size) return [];
  return (Array.isArray(state.activity) ? state.activity : []).slice(-ACTIVITY_LIMIT).map(normalize)
    .filter((v): v is ActivityEntry => !!v && (!accountId || !v.accountId || v.accountId === accountId)).slice(-size).reverse();
}
export function requestName(pathname: string): RequestName | undefined {
  const tail = pathname.split('/').at(-1); return tail && Object.hasOwn(requests, tail) ? tail as RequestName : undefined;
}
export function activityText(e: ActivityEntry, lang?: Language | number): string {
  const count = e.count ?? 0;
  const themeLabel = e.theme === 'spectrum' ? 'Spectrum' : e.theme === 'mescaline' ? 'Mescaline' : e.theme === 'acid' ? 'Acid' : 'Astolfo';
  if (lang === 'en') {
    switch (e.code) {
      case 'startup': return `Vault loaded · ${count} account${count === 1 ? '' : 's'}`;
      case 'sessions': return `Sessions restored · ${count}`;
      case 'compatibility': return `Version probe · ${e.compatibility === 'ok' ? 'Up to date' : e.compatibility === 'update' ? 'Update found' : 'Check failed'}`;
      case 'request': return `${e.request ? requestsEn[e.request] : 'Request'} · HTTP ${e.status ?? '?'}`;
      case 'request-error': return `${e.request ? requestsEn[e.request] : 'Request'} · Connection failed`;
      case 'account-added': return 'Account added'; case 'account-deleted': return 'Account removed'; case 'profile': return 'Profile saved';
      case 'session-saved': return 'Session saved'; case 'session-cleared': return 'Session cleared';
      case 'records': return `Workout log synced · ${count}`;
      case 'information': return `Overview synced · ${count} items`;
      case 'school-information': return `Venue rules synced · ${count} items`;
      case 'school-notices': return `Notices synced · ${count}`;
      case 'appearance': return 'Appearance saved';
      case 'detail': return 'Track detail loaded'; case 'plan': return `Schedule armed · ${count} account${count === 1 ? '' : 's'}`;
      case 'task': return `Task · ${e.phase ? phasesEn[e.phase] : 'Updated'}`;
      case 'theme': return `Palette · ${themeLabel}`;
      case 'operation-stopped': return 'Operation halted';
    }
  }
  switch (e.code) {
    case 'startup': return `档案已读取 · ${count} 个账号`;
    case 'sessions': return `载入本地会话 · ${count} 个`;
    case 'compatibility': return `版本检查 · ${e.compatibility === 'ok' ? '未发现更新' : e.compatibility === 'update' ? '发现新版本' : '检查失败'}`;
    case 'request': return `${e.request ? requests[e.request] : '请求'} · HTTP ${e.status ?? '未知'}`;
    case 'request-error': return `${e.request ? requests[e.request] : '请求'} · 连接失败`;
    case 'account-added': return '账号已添加'; case 'account-deleted': return '账号已删除'; case 'profile': return '账号设置已保存';
    case 'session-saved': return '新会话已保存'; case 'session-cleared': return '本地会话已清除';
    case 'records': return `运动记录已读取 · ${count} 条`;
    case 'information': return `概览已更新 · ${count} 项可用`;
    case 'school-information': return `学校资料已更新 · ${count} 项可用`;
    case 'school-notices': return `学校通知已更新 · ${count} 条`;
    case 'appearance': return '外观已保存';
    case 'detail': return '运动详情已读取'; case 'plan': return `执行计划已建立 · ${count} 个账号`;
    case 'task': return `任务 · ${e.phase ? phases[e.phase] : '状态变化'}`;
    case 'theme': return `配色 · ${themeLabel}`;
    case 'operation-stopped': return '操作已停止';
  }
}
