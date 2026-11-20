import assert from 'node:assert/strict';
import { Store } from '../../src/runtime/storage.js';
import { Engine } from '../../src/runtime/engine.js';
import { demoFetch, seedDemo } from '../../src/core/demo.js';
import { LocalAppClient } from '../../src/app/local-client.js';
import { TerminalUI } from '../../src/ui/index.js';
import { buildScene } from '../../src/ui/scene.js';
import { sceneRows } from '../../src/ui/canvas.js';
import { stripAnsi } from '../../src/ui/text.js';
import { memoryTerminal } from './memory-terminal.js';

const store = new Store(null);
await seedDemo(store);
const requests: string[] = [];
let emptyList = false, failDetail = false;
const engine = new Engine(store, async (input, init) => {
  const path = new URL(String(input)).pathname;
  requests.push(path);
  if (path.endsWith('/sport/detail') && failDetail) throw Error('offline detail failure');
  const response = await demoFetch(input, init);
  if (!path.endsWith('/sportlist')) return response;
  const body = await response.json() as {data: Array<Record<string, unknown>>};
  body.data = emptyList ? [] : [body.data[0]!, {...body.data[0], sportId: 'demo-record-2', beginTime: '2026-10-30 18:00:00'}];
  return Response.json(body);
});
await engine.initialize();
await engine.checkSchool();
requests.length = 0;
const app = new LocalAppClient(engine), terminal = memoryTerminal();
let prepares = 0;
const prepare = app.commands.prepareDefault;
app.commands.prepareDefault = (...args) => { prepares++; return prepare(...args); };
const ui = new TerminalUI(app, true, true, false, terminal), running = ui.run();
const wait = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function key(sequence: string) {
  terminal.stdin.write(sequence);
  await wait(sequence === '\x1b' ? 45 : 0);
  const start = performance.now();
  while (ui.view.busy && !ui.view.form) {
    if (performance.now() - start > 5000) throw Error('workout UI timed out');
    await wait(1);
  }
  await ui.flush();
}
function footer() {
  const scene = buildScene(app.state, ui.view, 118, 38, false, true);
  return sceneRows(scene).slice(-3).map(stripAnsi).join('\n');
}
async function ignored(sequence: string) {
  const revision = ui.controller.revision, count = requests.length, generated = prepares;
  await key(sequence);
  assert.equal(ui.controller.revision, revision);
  assert.equal(requests.length, count);
  assert.equal(prepares, generated);
  assert.equal(ui.view.busy, false);
}
try {
  await ui.flush();
  await key('\r'); await key('\r');
  assert.equal(ui.view.screen, 'oneshot');
  assert.match(footer(), /Enter 开始.*P 定时.*R 换一版.*A 高级/);
  assert.doesNotMatch(footer(), /D 距离|T 时长|0 自动/);
  const initial = ui.view.preview!, before = prepares;
  await key('R');
  assert.notEqual(ui.view.preview!.seed, initial.seed);
  assert.equal(prepares, before + 1);
  assert.equal(requests.length, 0);
  await key('a'); assert.match(footer(), /A 收起.*D 距离.*T 时长.*0 自动/);
  await key('a'); assert.match(footer(), /A 高级/);
  // Existing direct D/T/0 shortcuts also work with the advanced hints collapsed.
  await key('d'); assert.equal(ui.view.form?.title, '目标距离');
  assert.doesNotMatch(footer(), /R 换一版|A 高级/);
  await key('\x1b');
  await key('t'); assert.equal(ui.view.form?.title, '目标时长');
  await key('\x15'); await key('19:00'); await key('\r');
  assert.equal(ui.view.preview!.durationSec, 1140);
  await key('r'); assert.equal(ui.view.preview!.durationSec, 1140);
  await key('0'); assert.equal(ui.view.preview!.targets, undefined);
  await key('p'); assert.equal(ui.view.form?.title, '开始时间'); await key('\x1b');
  await key('\r'); assert.equal(ui.view.form?.title, '开始一次'); await key('\x1b');
  assert.equal(store.state.tasks.length, 0);
  const preview = ui.view.preview;
  ui.view.preview = undefined; ui.render(); await ui.flush();
  assert.doesNotMatch(footer(), /Enter 开始|P 定时|R 换一版|A 高级/);
  for (const char of ['r', 'd', 't', '0', 'p', 'a', '\r']) await ignored(char);
  ui.view.preview = preview; ui.view.busy = true; ui.render(); await ui.flush();
  assert.doesNotMatch(footer(), /R 换一版|Esc 返回/);
  terminal.stdin.write('r'); await wait(); assert.equal(requests.length, 0);
  ui.view.busy = false; ui.render();
  await key('\x1b'); await key('\x1b[B'); await key('\r');
  assert.equal(ui.view.screen, 'history');
  assert.match(footer(), /R 刷新/); assert.doesNotMatch(footer(), /Enter 详情/);
  await ignored('\r'); assert.equal(requests.length, 0);
  await key('r'); assert.equal(requests.length, 1); assert.ok(requests[0]!.endsWith('/sportlist'));
  assert.match(footer(), /Enter 详情.*R 刷新/);
  await key('\x1b[F'); assert.equal(ui.view.selected, 1);
  await key('\x1b[H'); assert.equal(ui.view.selected, 0);
  await key('\x1b[B'); assert.equal(ui.view.selected, 1);
  await key('\x1b[A'); assert.equal(ui.view.selected, 0);
  await key('\r'); assert.equal(ui.view.screen, 'records');
  assert.ok(ui.view.lines?.includes('暂无详情缓存'));
  assert.equal(requests.length, 1); assert.match(footer(), /R 刷新/);
  await key('r'); assert.equal(requests.length, 2); assert.ok(requests[1]!.endsWith('/sport/detail'));
  assert.ok(ui.view.lines?.includes('轨迹点  461'));
  await key('\x1b'); await key('\r'); assert.equal(requests.length, 2);
  assert.ok(ui.view.lines?.includes('轨迹点  461'));
  // Old workers return only list fields for this existing cache command.
  const loadCache = app.commands.loadCachedRecords;
  app.commands.loadCachedRecords = async (...args) => {
    const cache = await loadCache(...args);
    return cache && {records: cache.records, fetchedAt: cache.fetchedAt};
  };
  await key('\x1b'); await key('\r'); assert.equal(requests.length, 2);
  assert.ok(ui.view.lines?.includes('暂无详情缓存'));
  app.commands.loadCachedRecords = loadCache;
  await key('\x1b'); await key('\r'); assert.ok(ui.view.lines?.includes('轨迹点  461'));
  const lines = ui.view.lines;
  failDetail = true; await key('r'); assert.equal(requests.length, 3);
  assert.equal(ui.view.lines, lines); assert.match(footer(), /R 刷新/);
  failDetail = false; await key('r'); assert.equal(requests.length, 4);
  await key('\x1b');
  emptyList = true; await key('r'); assert.equal(requests.length, 5);
  assert.equal(ui.view.selected, 0); assert.doesNotMatch(footer(), /Enter 详情|↑↓/);
  await ignored('\r');
  emptyList = false; await key('r'); assert.equal(requests.length, 6);
  await key('\r'); assert.ok(ui.view.lines?.includes('暂无详情缓存')); assert.equal(requests.length, 6);
  // A records screen can also contain execution/plan text, with no refreshable record.
  ui.view.detailRecord = undefined; ui.render(); await ui.flush();
  assert.doesNotMatch(footer(), /R 刷新/); await ignored('r');
  await key('\x1b');
  await app.commands.clearSession(ui.view.accountId!);
  assert.doesNotMatch(footer(), /R 刷新/); await ignored('r');
  assert.equal(requests.length, 6);
  assert.equal(store.state.tasks.length, 0);
  process.stdout.write(JSON.stringify({ok: true, realInput: true, prepares,
    listRequests: requests.filter(p => p.endsWith('/sportlist')).length,
    detailRequests: requests.filter(p => p.endsWith('/sport/detail')).length,
    otherRequests: requests.filter(p => !/sportlist|sport\/detail/.test(p)).length,
    tasks: store.state.tasks.length}) + '\n');
} finally {
  await ui.controller.close(); await running; terminal.dispose();
}
