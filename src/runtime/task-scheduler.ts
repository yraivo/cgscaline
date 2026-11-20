import type { State } from '../core/model.js';

/** No idle timer. Running tasks and one-shot delayed audits wake at their deadline, with a clock check every 30s. */
export function nextTaskDelay(state: State, now = Date.now()): number | undefined {
  let next = Infinity;
  const running = state.tasks.filter(t => ['starting', 'waiting', 'committing'].includes(t.phase)).length;
  for (const task of state.tasks) {
    if (task.phase === 'waiting') next = Math.min(next, task.session?.commitAtLocalMs ?? task.session?.endAtMs ?? Infinity);
    if (task.phase === 'queued' && running < state.settings.maxConcurrent) next = Math.min(next, task.plannedStartAt ?? Infinity);
    if (task.phase === 'done' && task.autoAuditAt !== undefined && !running) next = Math.min(next, task.autoAuditAt);
  }
  return Number.isFinite(next) ? Math.min(30_000, Math.max(0, next - now)) : undefined;
}
export class TaskScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = true;
  constructor(private state: () => State, private tick: () => Promise<void>, private failed: () => void) {}
  start() { this.stopped = false; this.update(); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  update(minimumDelay = 0) {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.stopped || this.running) return;
    const delay = nextTaskDelay(this.state()); if (delay === undefined) return;
    this.timer = setTimeout(() => void this.run(), Math.max(minimumDelay, delay));
  }
  private async run() {
    this.timer = undefined; if (this.stopped) return; this.running = true; let failed = false;
    try { await this.tick(); } catch { failed = true; this.failed(); }
    finally { this.running = false; this.update(failed ? 1000 : 250); }
  }
}
