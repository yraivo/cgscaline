import { spawn } from 'node:child_process';
import { safeText, type State, type Task, type TaskPhase } from '../core/model.js';
import { APP_NAME } from '../core/brand.js';
import { recordStatus, taskSummary, taskAccountLabel } from '../ui/task-view.js';

export type Notify = (body: string) => void;
export const desktopNotify: Notify = body => {
  if (process.platform !== 'win32') return;
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
    "$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json; " +
    "$n=New-Object System.Windows.Forms.NotifyIcon; try { $n.Icon=[Drawing.SystemIcons]::Information; $n.Visible=$true; " +
    "$n.ShowBalloonTip(10000,[string]$v.title,[string]$v.body,[Windows.Forms.ToolTipIcon]::Info); " +
    "$until=[DateTime]::UtcNow.AddSeconds(12); while([DateTime]::UtcNow -lt $until){[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100} " +
    "} finally {$n.Dispose()}";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {}); child.stdin.on('error', () => {});
  child.stdin.end(Buffer.from(JSON.stringify({ title: APP_NAME, body: safeText(body, 250) })).toString('base64')); child.unref();
};

function finalAuditVerdict(t: Task): string {
  if (!t.audit?.found || !t.audit.record) return '';
  const status = recordStatus(t.audit.record);
  return status === '已通过' || status === '未通过' ? status : '';
}

/** Event-driven, no network requests; coalesce simultaneous completions and delayed audit verdicts. */
export class TaskNotifications {
  private phases = new Map<string, TaskPhase>();
  private verdicts = new Map<string, string>();
  private queued: string[] = [];
  private timer?: NodeJS.Timeout;
  constructor(state: State, private notify: Notify = desktopNotify) {
    for (const t of state.tasks) {
      this.phases.set(t.id, t.phase);
      this.verdicts.set(t.id, finalAuditVerdict(t));
    }
  }
  update(state: State) {
    if (state.settings.notifications === false) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.queued = [];
    }
    for (const t of state.tasks) {
      const previous = this.phases.get(t.id);
      const prevVerdict = this.verdicts.get(t.id) ?? '';
      const nextVerdict = finalAuditVerdict(t);
      this.phases.set(t.id, t.phase);
      this.verdicts.set(t.id, nextVerdict);
      if (state.settings.notifications === false) continue;
      if (previous !== t.phase) {
        if (t.phase === 'done' || t.phase === 'review') {
          this.queued.push(`${safeText(taskAccountLabel(t, state), 40)} · ${t.phase === 'review' ? '需要核对 · ' : ''}${safeText(taskSummary(t), 100)}`);
        }
      } else if (nextVerdict && nextVerdict !== prevVerdict && (t.phase === 'done' || t.phase === 'review')) {
        this.queued.push(`${safeText(taskAccountLabel(t, state), 40)} · 审核更新 · ${safeText(taskSummary(t), 100)}`);
      }
    }
    if (this.queued.length && !this.timer) this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.queued.length) { this.notify(this.queued.splice(0).slice(0, 4).join('\n')); }
  }
  close() { if (this.timer) clearTimeout(this.timer); this.queued = []; }
}
