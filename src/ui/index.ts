import type { AppClient } from '../app/contracts.js';
import { UIController } from './controller.js';
import { TerminalSession, type TerminalStreams } from './terminal.js';

export class TerminalUI {
  readonly controller: UIController;
  private terminal: TerminalSession;
  constructor(app: AppClient, demo = false, color = true, motion = true, streams: TerminalStreams = {}) {
    this.controller = new UIController(app, demo, color, motion);
    this.terminal = new TerminalSession(this.controller, streams);
  }
  get view() { return this.controller.view; }
  get frameCount() { return this.terminal.frameCount; }
  render() { this.controller.render(); }
  flush() { return this.terminal.flush(); }
  run() { return this.terminal.run(); }
}
