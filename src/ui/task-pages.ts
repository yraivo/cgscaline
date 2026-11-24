import type { AppState } from '../app/contracts.js';
import { resolveLanguage, tr } from '../core/i18n.js';
import { identity, safeText, UserError } from '../core/model.js';
import { taskAccountLabel, taskCheckLabel, taskLines, taskSportId, visibleTasks } from './task-view.js';
import type { UIController } from './controller.js';
import type { RenderView } from './view.js';

type TaskCommand = 'detail' | 'pause' | 'resume' | 'reconcile' | 'archive' | 'fast-forward';
export interface TaskPageAction {
  command: TaskCommand | 'move' | 'back';
  keys: readonly string[];
  hint: string;
}

export function taskPageActions(view: RenderView, state: AppState, demo: boolean): TaskPageAction[] | undefined {
  if (view.screen !== 'tasks' && view.screen !== 'executions') return undefined;
  if (view.busy || view.form) return [];
  const lang = resolveLanguage(state.settings.language);
  const list = visibleTasks(state, view.screen === 'executions');
  const task = list[view.selected];
  const actions: TaskPageAction[] = [];
  if (task) {
    const account = state.accounts.find(a => a.id === task.accountId);
    const session = account?.session;
    const usable = account && session && session.status !== 'invalid'
      && session.xh === account.username && session.identity === (account.profileIdentity ?? identity(account));
    const running = state.tasks.filter(t => ['starting', 'waiting', 'committing'].includes(t.phase));
    const bound = usable && (!task.prepared.accountIdentity || task.prepared.accountIdentity === session.identity);
    const queued = task.resumePhase === 'queued';
    const target = task.session?.commitAtLocalMs ?? task.session?.endAtMs;
    const resumable = task.phase === 'paused' && bound && (queued || (!!task.session
      && target !== undefined && Number.isFinite(target) && Date.now() - target <= 90_000
      && running.length < state.settings.maxConcurrent));
    actions.push({ command: 'detail', keys: ['return'], hint: tr(lang, 'Enter 详情', 'Enter Detail') });
    if (view.screen === 'tasks' && ['queued', 'waiting'].includes(task.phase))
      actions.push({ command: 'pause', keys: ['p'], hint: tr(lang, 'P 暂停', 'P Pause') });
    if (view.screen === 'tasks' && resumable)
      actions.push({ command: 'resume', keys: ['r'], hint: tr(lang, 'R 恢复', 'R Resume') });
    if (usable && taskSportId(task) && !running.some(t => t.accountId === task.accountId))
      actions.push({
        command: 'reconcile',
        keys: ['c'],
        hint: view.screen === 'executions' ? tr(lang, 'C 刷新核对', 'C Verify') : tr(lang, 'C 核对', 'C Verify'),
      });
    if (view.screen === 'tasks' && !['starting', 'waiting', 'committing'].includes(task.phase))
      actions.push({ command: 'archive', keys: ['x'], hint: tr(lang, 'X 归档', 'X Archive') });
    if (view.screen === 'tasks' && demo && task.phase === 'waiting' && task.session)
      actions.push({ command: 'fast-forward', keys: ['f'], hint: tr(lang, 'F 快进', 'F Warp') });
  }
  if (list.length) actions.push({
    command: 'move',
    keys: ['up', 'down', 'pageup', 'pagedown', 'home', 'end'],
    hint: tr(lang, '↑↓ / PgUp PgDn 选择', '↑↓ / PgUp PgDn Select'),
  });
  actions.push({ command: 'back', keys: ['escape'], hint: tr(lang, 'Esc 返回', 'Esc Back') });
  return actions;
}

export class TaskPages {
  private deadline?: number;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private ui: UIController) {}
  /** One local repaint when a paused task's recovery window expires; no polling. */
  syncDeadline() {
    const view = this.ui.view;
    const task = view.screen === 'tasks' ? visibleTasks(this.ui.app.state)[view.selected] : undefined;
    const target = task?.session?.commitAtLocalMs ?? task?.session?.endAtMs;
    const expires = task?.phase === 'paused' && task.resumePhase !== 'queued' && target !== undefined
      && Number.isFinite(target) ? target + 90_001 : undefined;
    const next = !this.ui.closed && expires !== undefined && expires > Date.now() ? expires : undefined;
    if (this.deadline === next) return;
    this.dispose();
    this.deadline = next;
    if (next !== undefined) this.timer = setTimeout(() => {
      this.deadline = undefined;
      this.ui.render();
    }, Math.min(2_147_483_647, next - Date.now()));
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; this.deadline = undefined; }
  async run(command: TaskCommand) {
    const { view, app } = this.ui;
    const lang = resolveLanguage(app.state.settings.language);
    const screen = view.screen;
    const task = visibleTasks(app.state, screen === 'executions')[view.selected];
    if (!task) return;
    if (command === 'detail') {
      const check = view.taskChecks?.[task.id];
      this.ui.navigate('records');
      view.returnTo = screen === 'executions' ? 'executions' : 'tasks';
      view.title = tr(lang, '执行详情', 'EXECUTION DETAIL');
      view.lines = taskLines(task, app.state, check, undefined, lang);
      return;
    }
    if (command === 'reconcile') {
      try {
        const audit = await app.commands.reconcileTask(task.id, true);
        if (!audit) throw new UserError(tr(lang, '本次核对未返回结果。', 'Verification returned no result.'));
        (view.taskChecks ??= {})[task.id] = { kind: 'result', audit: structuredClone(audit) };
      } catch (error) {
        const message = error instanceof UserError
          ? `${tr(lang, '核对失败：', 'Verify failed: ')}${safeText(error.message, 200)}`
          : tr(lang, '核对失败，请稍后再试。', 'Verification failed, try again later.');
        (view.taskChecks ??= {})[task.id] = { kind: 'error', message };
      }
      view.notice = taskCheckLabel(view.taskChecks![task.id]!, lang);
      return;
    }
    if (command === 'resume') {
      await this.ui.confirm(
        tr(lang, '恢复任务', 'RESUME TASK'),
        lang === 'en' ? `Resume task for ${taskAccountLabel(task, app.state)}?` : `恢复 ${taskAccountLabel(task, app.state)} 的任务？`,
      );
      await app.commands.resume(task.id);
    } else if (command === 'archive') {
      await this.ui.confirm(tr(lang, '归档任务', 'ARCHIVE TASK'), tr(lang, '归档这个任务？', 'Archive this task?'));
      await app.commands.archive(task.id);
    } else if (command === 'pause') await app.commands.pause(task.id);
    else if (command === 'fast-forward') await app.commands.fastForwardDemo(task.id);
    if (view.taskChecks) delete view.taskChecks[task.id];
    view.selected = Math.min(view.selected, Math.max(0, visibleTasks(app.state, screen === 'executions').length - 1));
    view.notice = '';
  }
}
