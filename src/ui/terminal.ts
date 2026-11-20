import type { Readable, Writable } from 'node:stream';
import { resolveAnimationFps } from '../render/appearance.js';
import { terminalTitle } from '../core/brand.js';
import { UserError } from '../core/model.js';
import { TerminalCanvas } from './canvas.js';
import type { UIController } from './controller.js';
import { TerminalInput } from './input.js';
import { buildScene } from './scene.js';

export interface TerminalStreams {
  stdin?: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(raw: boolean): unknown };
  stdout?: Writable & { isTTY?: boolean; columns?: number; rows?: number };
  stderr?: Writable;
}
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?1004h\x1b[?2004h';
const LEAVE = '\x1b[0m\x1b[?2004l\x1b[?1004l\x1b[?25h\x1b[?1049l';

/** Terminal lifecycle and drawing only; execution belongs to the AppClient. */
export class TerminalSession {
  private input: NonNullable<TerminalStreams['stdin']>;
  private output: NonNullable<TerminalStreams['stdout']>;
  private canvas = new TerminalCanvas();
  private parser: TerminalInput;
  private focused = true;
  private running = false;
  private dirty = false;
  private scheduled = false;
  private blocked = false;
  private pendingWrites = 0;
  private waiters = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private period = 0;
  private motion = 0;
  private resolve?: () => void;
  private reject?: (error: Error) => void;
  private failure?: Error;
  frameCount = 0;
  constructor(private controller: UIController, streams: TerminalStreams = {}) {
    this.input = streams.stdin ?? process.stdin;
    this.output = streams.stdout ?? process.stdout;
    this.parser = new TerminalInput(
      (text, key) => { if (this.focused) controller.handle(text, key); },
      text => { if (this.focused && controller.view.form) controller.handle(text, {}); },
      focused => {
        this.focused = focused;
        if (focused) this.canvas.invalidate();
        this.requestRender();
      },
    );
  }
  private dimensions() {
    this.controller.width = Math.max(1, Math.floor(this.output.columns || 100));
    this.controller.height = Math.max(1, Math.floor(this.output.rows || 38));
  }
  private syncAnimation() {
    const { view, app } = this.controller;
    const enabled = this.running && this.focused && this.controller.motion && app.state.settings.motion !== false
      && !view.form && !view.busy;
    const period = enabled ? 1000 / resolveAnimationFps(app.state.settings.animationFps) : 0;
    if (period === this.period) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.period = period;
    if (period) this.timer = setInterval(() => { this.motion = Date.now() / 1000; this.requestRender(); }, period);
  }
  private requestRender = () => {
    if (!this.running) return;
    this.dirty = true;
    this.syncAnimation();
    if (!this.focused || this.blocked || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.paint(); });
  };
  private paint() {
    if (!this.running || !this.focused || this.blocked || !this.dirty) { this.settle(); return; }
    try {
      this.dimensions();
      const c = this.controller;
      const scene = buildScene(c.app.state, { ...c.view,
        motion: c.motion && c.app.state.settings.motion !== false ? this.motion : 0,
        motionLocked: !c.motion, background: c.app.background, connected: c.app.connected,
      }, c.width, c.height, c.color, c.demo);
      this.dirty = false;
      const output = this.canvas.paint(scene, c.color);
      this.frameCount++;
      if (output) this.write(this.output === process.stdout && c.color ? `\x1b[?2026h${output}\x1b[?2026l` : output);
      this.settle();
    } catch (error) { this.fail(error as Error); }
  }
  private write(text: string) {
    this.pendingWrites++;
    try {
      this.blocked = !this.output.write(text, error => {
        this.pendingWrites--;
        if (error) this.fail(error);
        this.settle();
      });
    } catch (error) { this.pendingWrites--; this.fail(error as Error); }
  }
  private settle() {
    if (!this.failure && (this.pendingWrites || this.blocked || this.scheduled || (this.dirty && this.focused && this.running))) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  async flush() {
    if (this.failure) throw this.failure;
    if (this.pendingWrites || this.blocked || this.scheduled || (this.dirty && this.focused && this.running))
      await new Promise<void>(resolve => this.waiters.add(resolve));
    if (this.failure) throw this.failure;
  }
  private resize = () => { this.dimensions(); this.canvas.invalidate(); this.requestRender(); };
  private drain = () => { this.blocked = false; if (this.dirty) this.requestRender(); this.settle(); };
  private close = () => { this.resolve?.(); };
  private disconnect = () => { void this.controller.close().catch(this.fail); };
  private fail = (error: Error) => { this.failure ??= error; this.reject?.(error); this.settle(); };
  async run(): Promise<void> {
    const wasRaw = this.input.isRaw === true, wasFlowing = this.input.readableFlowing === true;
    let entered = false, unsubscribe: (() => void) | undefined;
    const stopped = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    try {
      if (!this.input.isTTY || !this.output.isTTY) throw new UserError('交互模式需要终端；可用 --demo --preview 输出预览。');
      this.running = true;
      process.title = 'CGSCALINE';
      this.controller.start();
      unsubscribe = this.controller.subscribe(this.requestRender);
      this.controller.once('close', this.close);
      this.output.on('error', this.fail);
      this.output.on('close', this.disconnect);
      this.output.on('drain', this.drain);
      this.output.on('resize', this.resize);
      this.input.on('error', this.fail);
      this.input.on('end', this.disconnect);
      this.input.on('close', this.disconnect);
      this.input.on('data', this.parser.write);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, this.disconnect);
      entered = true;
      this.write(terminalTitle + ENTER);
      this.input.setRawMode?.(true);
      this.input.resume();
      this.resize();
      await stopped;
    } finally {
      this.running = false;
      clearInterval(this.timer);
      unsubscribe?.();
      this.controller.off('close', this.close);
      this.input.off('data', this.parser.write);
      this.input.off('end', this.disconnect);
      this.input.off('close', this.disconnect);
      this.input.off('error', this.fail);
      this.output.off('resize', this.resize);
      this.output.off('close', this.disconnect);
      this.output.off('drain', this.drain);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, this.disconnect);
      this.parser.dispose();
      try {
        if (entered) {
          try { this.input.setRawMode?.(wasRaw); }
          finally {
            if (!wasFlowing) this.input.pause();
            if (!this.output.destroyed && !this.output.writableEnded) {
              await new Promise<void>(resolve => {
                try { this.output.write(LEAVE, () => resolve()); }
                catch { resolve(); }
              });
            }
          }
        }
      } finally {
        this.output.off('error', this.fail);
        this.settle();
        await this.controller.close();
      }
    }
  }
}
