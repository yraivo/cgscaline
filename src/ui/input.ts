import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
export interface InputKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

export function pageKeyAction<T extends {keys: readonly string[]}>(actions: readonly T[], text: string, key: InputKey): T | undefined {
  if (key.ctrl || key.meta) return undefined;
  return actions.find(action => action.keys.includes(key.name ?? '') || action.keys.includes(text.toLowerCase()));
}
const PASTE_START = '\x1b[200~', PASTE_END = '\x1b[201~';
/** Frame terminal reports and paste before handing ordinary keys to Node's parser. */
export class TerminalInput {
  private decoder = new StringDecoder('utf8');
  private keys = new PassThrough();
  private pending = '';
  private paste: string | undefined;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private onKey: (text: string, key: InputKey) => void,
    private onPaste: (text: string) => void,
    private onFocus: (focused: boolean) => void,
  ) {
    emitKeypressEvents(this.keys);
    this.keys.on('keypress', this.key);
  }
  private key = (text: string | undefined, key: Key) => {
    const name = ['\x1bOP', '\x1b[11~', '\x1b[P'].includes(key.sequence ?? '')
      ? 'f1' : key.name === 'delete' ? 'backspace' : key.name;
    this.onKey(text ?? '', { ...key, name });
  };
  write = (chunk: Buffer | string) => {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    this.consume();
  };
  private consume() {
    while (this.pending) {
      if (this.paste !== undefined) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(PASTE_END.length - 1, this.pending.length);
          this.paste = (this.paste + this.pending.slice(0, this.pending.length - keep)).slice(0, 2048);
          this.pending = this.pending.slice(this.pending.length - keep);
          return;
        }
        const text = (this.paste + this.pending.slice(0, end)).slice(0, 2048);
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.paste = undefined;
        this.onPaste(text);
        continue;
      }
      const escape = this.pending.indexOf('\x1b');
      if (escape !== 0) {
        const end = escape < 0 ? this.pending.length : escape;
        this.keys.write(this.pending.slice(0, end));
        this.pending = this.pending.slice(end);
        continue;
      }
      let sequence: string | undefined;
      if (this.pending[1] === '[') {
        sequence = this.pending.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)?.[0];
      } else if (this.pending[1] === 'O') {
        if (this.pending.length >= 3) sequence = this.pending.slice(0, 3);
      } else if (this.pending.length > 1) {
        sequence = this.pending.slice(0, this.pending.codePointAt(1)! > 0xffff ? 3 : 2);
      }
      if (!sequence) {
        if (this.pending.length > 64) { this.pending = ''; return; }
        this.escapeTimer = setTimeout(() => {
          const singleEscape = this.pending === '\x1b';
          this.pending = '';
          if (singleEscape) this.onKey('', { name: 'escape', sequence: '\x1b' });
        }, 30);
        return;
      }
      this.pending = this.pending.slice(sequence.length);
      if (sequence === '\x1b[I' || sequence === '\x1b[O') this.onFocus(sequence === '\x1b[I');
      else if (sequence === PASTE_START) this.paste = '';
      else if (sequence !== PASTE_END) this.keys.write(sequence);
    }
  }
  dispose() {
    clearTimeout(this.escapeTimer);
    this.keys.off('keypress', this.key);
    this.keys.destroy();
    this.pending = '';
    this.paste = undefined;
  }
}
