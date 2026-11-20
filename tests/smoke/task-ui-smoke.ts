import assert from 'node:assert/strict';
import { Store } from '../../src/runtime/storage.js';
import { Engine } from '../../src/runtime/engine.js';
import { demoFetch, seedDemo } from '../../src/core/demo.js';
import { LocalAppClient } from '../../src/app/local-client.js';
import { commandsFor, type Invoke } from '../../src/app/client.js';
import type { AppClient, AppState } from '../../src/app/contracts.js';
import { identity, type Task, type TaskPhase } from '../../src/core/model.js';
import { TerminalUI } from '../../src/ui/index.js';
import { buildScene } from '../../src/ui/scene.js';
import { sceneRows } from '../../src/ui/canvas.js';
import { stripAnsi } from '../../src/ui/text.js';
import { taskPageActions } from '../../src/ui/task-pages.js';
import { memoryTerminal } from './memory-terminal.js';

const store = new Store(null);
await seedDemo(store);
const requests: string[] = [];
let outcome: 'pending' | 'passed' | 'rejected' | 'missing' | 'failure' = 'pending';
const engine = new Engine(store, async (input, init) => {
  const path = new URL(String(input)).pathname;
  requests.push(path);
  if (path.endsWith('/sportlist')) {
    if (outcome === 'failure') throw Error('offline failure');
    const data = outcome === 'missing' ? [] : [{sportId: 'demo-record', beginTime: '2026-10-31 18:00:00',
      odometer: '3.03', activeTime: '00:20:00', isValid: outcome === 'rejected' ? '0' : '1',
      checkStatus: outcome === 'pending' ? '0' : '1', inValidReason: outcome === 'rejected' ? '4' : ''}];
    return Response.json({code: 200, data});
  }
  return demoFetch(input, init);
});
await engine.initialize(); await engine.checkSchool();
requests.length = 0;
const account = store.state.accounts[0]!, prepared = await engine.prepareDefault(account.id);
let sequence = 0;
function task(phase: TaskPhase, patch: Partial<Task> = {}): Task {
  return {id: `task-${++sequence}`, accountId: account.id, accountLabel: account.label,
    identity: identity(account), sessionId: account.session!.id, createdAt: Date.now(),
    prepared, phase, note: '', ...patch};
}
const session = () => ({sportId: 'demo-record', startAtMs: Date.now() - 1000,
  endAtMs: Date.now() + 600_000, commitAtLocalMs: Date.now() + 600_000});
const base = new LocalAppClient(engine), calls: string[] = [];
let frozen: AppState | undefined;
// Deliberately leave the displayed snapshot stale after C, proving the return value is used.
const invoke = async (method: keyof typeof base.commands, args: unknown[]) => {
  calls.push(method);
  const before = client.state;
  const result = await Reflect.apply(base.commands[method], base.commands, args);
  if (method === 'reconcileTask') frozen = before;
  return result;
};
const client: AppClient = {get state() { return frozen ?? base.state; }, get notices() {return base.notices;},
  background: false, connected: true, commands: commandsFor(invoke as Invoke), subscribe: base.subscribe,
  close: () => base.close()};
const terminal = memoryTerminal(), ui = new TerminalUI(client, true, true, false, terminal), running = ui.run();
const wait = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function key(text: string) {
  terminal.stdin.write(text); await wait(text === '\x1b' ? 45 : 0);
  const start = performance.now();
  while (ui.view.busy && !ui.view.form) { if (performance.now() - start > 5000) throw Error('task UI timed out'); await wait(1); }
  await ui.flush();
}
function frame() { return sceneRows(buildScene(client.state, ui.view, 118, 38, false, true)).map(stripAnsi).join('\n'); }
function footer() { return frame().split('\n').slice(-3).join('\n'); }
async function show(tasks: Task[], history = false) {
  const before = calls.length, http = requests.length;
  frozen = undefined; store.state.tasks = tasks; engine.emit('change');
  ui.controller.home(); await ui.flush(); await key(history ? 'h' : 't');
  assert.equal(ui.view.screen, history ? 'executions' : 'tasks');
  assert.equal(calls.length, before); assert.equal(requests.length, http);
}
async function ignored(...keys: string[]) {
  const count = calls.length, http = requests.length;
  for (const text of keys) { await key(text); assert.equal(ui.view.form, undefined); assert.equal(ui.view.busy, false); }
  assert.equal(calls.length, count); assert.equal(requests.length, http);
}
async function confirm(text: string, title: string) {
  const count = calls.length;
  await key(text); assert.equal(ui.view.form?.title, title); assert.equal(calls.length, count);
  await key('y'); await key('\r');
}
try {
  await ui.flush();
  for (const history of [false, true]) {
    await show([], history); assert.doesNotMatch(footer(), /Enter|P 暂停|R 恢复|C |X 归档|F 快进|↑↓/);
    await ignored('\r', 'p', 'r', 'c', 'x', 'f');
  }
  const queued = task('queued', {plannedStartAt: Date.now() + 600_000});
  await show([queued]); assert.match(footer(), /P 暂停.*X 归档/);
  assert.doesNotMatch(footer(), /R 恢复|C 核对|F 快进/); await ignored('r', 'c', 'f');
  await key('p'); assert.equal(queued.phase, 'paused'); assert.equal(calls.at(-1), 'pause');
  assert.match(footer(), /R 恢复/);
  const pausedCalls = calls.length;
  await key('r'); assert.equal(ui.view.form?.title, '恢复任务'); await key('\x1b'); assert.equal(calls.length, pausedCalls);
  await confirm('r', '恢复任务'); assert.equal(queued.phase, 'queued'); assert.equal(calls.at(-1), 'resume');
  await key('x'); assert.equal(ui.view.form?.title, '归档任务'); await key('\x1b');
  await confirm('x', '归档任务'); assert.equal(queued.phase, 'abandoned'); assert.equal(calls.at(-1), 'archive');
  assert.equal(requests.length, 0);
  const first = task('queued', {plannedStartAt: Date.now() + 600_000});
  const last = task('queued', {plannedStartAt: Date.now() + 600_000});
  await show([first, last]);
  const selectionCalls = calls.length;
  await key('\x1b[F'); assert.equal(ui.view.selected, 1);
  await key('\x1b[H'); assert.equal(ui.view.selected, 0);
  await key('\x1b[B'); assert.equal(ui.view.selected, 1);
  await key('\x1b[A'); assert.equal(ui.view.selected, 0);
  await key('\x1b[F'); assert.equal(ui.view.selected, 1);
  assert.equal(calls.length, selectionCalls);
  await confirm('x', '归档任务'); assert.equal(last.phase, 'abandoned');
  assert.equal(ui.view.selected, 0); assert.match(footer(), /P 暂停/);

  const waiting = task('waiting', {session: session()});
  await show([waiting]); assert.match(footer(), /P 暂停.*F 快进/);
  assert.doesNotMatch(footer(), /R 恢复|C 核对|X 归档/); await ignored('r', 'c', 'x');
  assert.equal(taskPageActions(ui.view, client.state, false)!.some(a => a.command === 'fast-forward'), false);
  await key('p'); assert.equal(waiting.phase, 'paused'); assert.match(footer(), /R 恢复.*C 核对.*X 归档/);
  await confirm('r', '恢复任务'); assert.equal(waiting.phase, 'waiting');
  assert.equal(requests.length, 0);
  for (const phase of ['starting', 'committing'] as const) {
    await show([task(phase, {session: session()})]);
    assert.doesNotMatch(footer(), /P 暂停|R 恢复|C 核对|X 归档|F 快进/);
    await ignored('p', 'r', 'c', 'x', 'f');
  }
  await show([task('paused', {resumePhase: 'waiting'})]);
  assert.doesNotMatch(footer(), /R 恢复|C 核对/); await ignored('r', 'c', 'p', 'f');
  await show([task('paused', {resumePhase: 'waiting', session: {...session(), commitAtLocalMs: Date.now() - 91_000}})]);
  assert.doesNotMatch(footer(), /R 恢复/); await ignored('r');
  await show([task('paused', {resumePhase: 'waiting', session: {...session(), commitAtLocalMs: Date.now() - 89_800}})]);
  assert.match(footer(), /R 恢复/);
  const beforeExpiry = ui.frameCount, expiryCalls = calls.length;
  await wait(260); await ui.flush();
  assert.ok(ui.frameCount > beforeExpiry); assert.doesNotMatch(footer(), /R 恢复/);
  await ignored('r'); assert.equal(calls.length, expiryCalls);
  await show([task('paused', {resumePhase: 'queued', prepared: {...prepared, accountIdentity: 'old-device'}})]);
  assert.doesNotMatch(footer(), /R 恢复/); await ignored('r');
  account.session!.status = 'invalid';
  await show([task('paused', {resumePhase: 'waiting', session: session()})]);
  assert.doesNotMatch(footer(), /R 恢复|C 核对/); await ignored('r', 'c');
  account.session!.status = 'saved';
  const other = task('waiting', {accountId: store.state.accounts[1]!.id, session: session()});
  store.state.settings.maxConcurrent = 1;
  await show([task('paused', {resumePhase: 'waiting', session: session()}), other]);
  assert.doesNotMatch(footer(), /R 恢复/); await ignored('r');
  // Resuming a queued plan is still allowed at the running limit.
  await show([task('paused', {resumePhase: 'queued'}), other]); assert.match(footer(), /R 恢复/);
  store.state.settings.maxConcurrent = 2;

  const interrupted = task('review', {note: '上次提交中断，按 C 查看结果。'});
  const oldNote = interrupted.note;
  for (const history of [false, true]) {
    await show([interrupted], history);
    assert.match(frame(), /没有运动编号，可到“我的记录”查看/); assert.doesNotMatch(frame(), /按 C 查看结果/);
    assert.doesNotMatch(footer(), /C (刷新核对|核对)/); await ignored('c', 'r', 'p', 'f');
    if (history) await ignored('x');
    const count = calls.length;
    await key('\r'); assert.equal(ui.view.screen, 'records');
    assert.match(ui.view.lines!.join('\n'), /没有运动编号，可到“我的记录”查看/);
    assert.doesNotMatch(ui.view.lines!.join('\n'), /按 C 查看结果/);
    await key('\x1b'); assert.equal(calls.length, count);
  }
  assert.equal(interrupted.note, oldNote);
  const oldRecord = {sportId: 'demo-record', beginTime: '2026-10-31 18:00:00', endTime: '', routeId: '27',
    isValid: '1', checkStatus: '1', inValidReason: '', tip: '', subType: '', odometer: '3.03',
    stepCount: '', avgSpeed: '', activeTime: '00:20:00'};
  const finished = task('done', {session: session(), audit: {checkedAt: Date.now() - 60_000, found: true, record: oldRecord}});
  await show([finished, task('waiting', {session: session()})], true);
  assert.doesNotMatch(footer(), /C 刷新核对/); await ignored('c');
  await show([finished], true); assert.match(footer(), /C 刷新核对/); await ignored('p', 'r', 'x', 'f');
  const expectations = [['passed', '已通过'], ['pending', '待审核'], ['rejected', '未通过'], ['missing', '本次查询未找到'], ['failure', '核对失败']] as const;
  for (const [next, label] of expectations) {
    outcome = next;
    const count: number = calls.length, http: number = requests.length;
    await key('C'); assert.equal(calls.length, count + 1); assert.equal(calls.at(-1), 'reconcileTask');
    assert.equal(requests.length, http + 1); assert.ok(ui.view.notice.includes(label));
    assert.ok(frame().includes(label));
    if (next === 'missing' || next === 'failure') assert.doesNotMatch(frame(), /已通过|待审核|未通过/);
    if (next === 'failure') assert.doesNotMatch(frame(), /本次查询未找到/);
    await key('\r'); assert.equal(ui.view.screen, 'records');
    const detail = ui.view.lines!.join('\n'); assert.ok(detail.includes(label));
    if (next === 'missing' || next === 'failure') assert.doesNotMatch(detail, /已通过|待审核|未通过/);
    if (next === 'failure') assert.doesNotMatch(detail, /本次查询未找到/);
    await key('\x1b'); assert.equal(calls.length, count + 1); assert.equal(requests.length, http + 1);
  }
  assert.equal(finished.phase, 'done');
  assert.equal(finished.audit!.found, false); assert.equal(finished.audit!.record!.checkStatus, '1');
  assert.ok(requests.every(p => p.endsWith('/sportlist')));
  frozen = undefined;
  const beforeReopen = calls.length;
  await key('\x1b'); await key('h');
  assert.match(frame(), /上次查询未找到/); assert.doesNotMatch(frame(), /本次查询未找到/);
  assert.equal(calls.length, beforeReopen);
  process.stdout.write(JSON.stringify({ok: true, realInput: true, backendCalls: calls.length,
    reconciliations: calls.filter(c => c === 'reconcileTask').length, recordRequests: requests.length,
    login: 0, submits: 0, outcomes: expectations.map(v => v[1])}) + '\n');
} finally { await ui.controller.close(); await running; terminal.dispose(); }
