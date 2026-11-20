import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { ClientState, commandsFor } from '../src/app/client.js';
import type { AppClient } from '../src/app/contracts.js';
import { TerminalUI } from '../src/ui/index.js';

class Client extends ClientState implements AppClient {
  readonly background = true;
  readonly connected = true;
  readonly commands = commandsFor(() => { throw Error('unexpected command'); });
  closes = 0;
  async close() { this.closes++; }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const makeInput = () => Object.assign(new PassThrough(), {
  isTTY: true, isRaw: false,
  setRawMode(raw: boolean) { this.isRaw = raw; return this; },
});

test('慢终端合并中间画面，flush 等待写入，退出恢复终端并移除监听器', async () => {
  const app = new Client(), input = makeInput();
  const callbacks: Array<() => void> = [], writes: string[] = [];
  const stdout = Object.assign(new Writable({ highWaterMark: 1, write(chunk, _enc, done) {
    writes.push(String(chunk)); callbacks.push(done);
  }}), { isTTY: true, columns: 80, rows: 24 });
  const signals = process.listenerCount('SIGTERM');
  const ui = new TerminalUI(app, false, false, false, { stdin: input, stdout });
  const running = ui.run();
  for (let i = 0; i < 100; i++) { ui.view.notice = `最新 ${i}`; ui.render(); }
  await turn();
  assert.equal(writes.length, 1);
  assert.equal(ui.frameCount, 0);
  let flushed = false;
  const flushing = ui.flush().then(() => { flushed = true; });
  await turn(); assert.equal(flushed, false);
  callbacks.shift()!(); await turn();
  assert.match(writes[1]!, /最新 99/);
  assert.equal(flushed, false);
  callbacks.shift()!(); await flushing;
  assert.equal(writes.length, 2);
  await ui.controller.quit(); await turn();
  assert.match(writes[2]!, /\x1b\[\?1049l/);
  callbacks.shift()!(); await running;
  assert.equal(app.closes, 1);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
  assert.equal(stdout.listenerCount('resize'), 0);
  assert.equal(process.listenerCount('SIGTERM'), signals);
  input.destroy(); stdout.destroy();
});

test('输入断开会关闭界面；输出失败仍释放客户端和 raw mode', async () => {
  for (const failure of [false, true]) {
    const app = new Client(), input = makeInput();
    let output = '';
    const stdout = Object.assign(new Writable({ write(chunk, _enc, done) { output += String(chunk); done(); } }), { isTTY: true, columns: 80, rows: 24 });
    const ui = new TerminalUI(app, false, false, false, { stdin: input, stdout });
    const running = ui.run();
    const finished = failure ? assert.rejects(running, /terminal failure/) : running;
    await ui.flush();
    if (failure) stdout.destroy(new Error('terminal failure'));
    else input.end();
    await finished;
    assert.equal(input.isRaw, false);
    assert.equal(app.closes, 1);
    if (!failure) assert.ok(output.includes('\x1b[?1049l'));
    input.destroy(); stdout.destroy();
  }
});
