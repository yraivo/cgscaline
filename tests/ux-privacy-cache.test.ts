import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/runtime/storage.js';
import { Engine } from '../src/runtime/engine.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { frame, stripAnsi } from '../src/render/theme.js';
import { moreActions } from '../src/ui/actions.js';
import { taskSummary, taskLines } from '../src/ui/task-view.js';
import { activityText } from '../src/core/activity.js';
import { deviceHeaders, type Task } from '../src/core/model.js';
type TaskAudit = NonNullable<Task['audit']>;

test('主页直接提供 C 检查更新与 X 隐私模式，更多菜单不再重复放检查更新', async () => {
  assert.equal(moreActions.some(([k, label]) => (k as string) === 'c' || label.includes('检查更新')), false);
  const store = new Store(null);
  await seedDemo(store);
  const home = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 118, 38, false, true));
  assert.match(home, /C 更新/);
  assert.match(home, /X 隐私/);
});

test('隐私模式在全界面将学号、昵称、学校编码、设备标识、运动编号和代理地址遮罩为 *，关闭后恢复', async () => {
  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  await engine.checkSchool();
  const a = store.state.accounts[0]!;
  await engine.information(a.id, true);
  await engine.schoolInformation(a.id, true);
  const rows = await engine.records(a.id);
  const detail = await engine.recordDetail(a.id, rows[0]!.sportId);
  const task = await engine.start(a.id, await engine.prepareDefault(a.id));
  await engine.fastForwardDemo(task.id);
  const sportId = task.session!.sportId;
  const imei = deviceHeaders(a.device).imei;

  a.proxy = 'http://user:secret@10.20.30.40:7890';
  store.state.settings.schoolProxy = 'http://192.168.1.9:8080';

  await engine.configureAppearance({ privacyMode: true });
  assert.equal(store.state.settings.privacyMode, true);

  const screens = [
    stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 118, 38, false, true)),
    stripAnsi(frame(store.state, { screen: 'account', accountId: a.id, selected: 0, notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'manage', accountId: a.id, selected: 0, notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'information', accountId: a.id, selected: 0, notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'school', accountId: a.id, selected: 0, infoTab: 0, notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'history', accountId: a.id, selected: 0, history: rows, historyFetchedAt: Date.now(), notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'records', accountId: a.id, selected: 0, detailRecord: rows[0], lines: taskLines(task, store.state), notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'executions', selected: 0, notice: '' }, 118, 38, false)),
    stripAnsi(frame(store.state, { screen: 'settings', selected: 0, notice: '' }, 118, 38, false)),
  ].join('\n');

  for (const sensitive of [a.username, a.label, store.state.settings.schoolId!, a.device.androidId, imei, sportId, '10.20.30.40', '192.168.1.9', 'secret']) {
    assert.equal(screens.includes(sensitive), false, `should mask ${sensitive}`);
  }
  assert.match(screens, /隐私模式/);
  assert.match(screens, /X 显示/);
  assert.ok((detail.coordinateCount ?? 0) > 0);

  await engine.configureAppearance({ privacyMode: false });
  const restored = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 118, 38, false, true));
  assert.ok(restored.includes(a.username));
  assert.ok(restored.includes(a.label));
  assert.equal(restored.includes('已提交 提交'), false);
  await engine.shutdown();
});

test('H 执行页核对与我的记录双向同步且落盘持久化，H 刷新不丢失已缓存的具体路径详情', async () => {
  const store = new Store(null);
  await seedDemo(store);
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    return demoFetch(input, init);
  };
  const engine = new Engine(store, fetcher);
  await engine.initialize();
  await engine.checkSchool();
  const a = store.state.accounts[0]!;

  // 1. 先在我的记录拉取列表与具体路径详情，验证跨进程/重开持久化
  await engine.records(a.id);
  await engine.recordDetail(a.id, 'demo-record');
  const beforeReopenCalls = calls;

  const reopenedStore = new Store(null);
  reopenedStore.state = structuredClone(store.state);
  const reopened = new Engine(reopenedStore, async () => {
    throw Error('unexpected network on cache read');
  });
  await reopened.initialize();
  const persisted = await reopened.loadCachedRecords(a.id, 'demo-record');
  assert.ok(persisted);
  assert.equal(persisted.records[0]?.sportId, 'demo-record');
  assert.equal(persisted.detail?.coordinateCount, 461);

  // 2. 创建已完成任务并在 H (reconcileTask) 中刷新：应直接更新我的记录缓存且保留未变记录的具体路径详情
  const task = await engine.start(a.id, await engine.prepareDefault(a.id));
  await engine.fastForwardDemo(task.id);
  task.session!.sportId = 'demo-record';
  task.result!.sportId = 'demo-record';
  const callsBeforeReconcile = calls;
  const audit = await engine.reconcileTask(task.id, true);
  assert.equal(audit.found, true);
  assert.equal(calls, callsBeforeReconcile + 1);

  // 进入我的记录与具体路径无需再发请求，旧详情仍在
  const afterReconcile = await engine.loadCachedRecords(a.id, 'demo-record');
  assert.equal(afterReconcile?.fetchedAt, audit.checkedAt);
  assert.equal(afterReconcile?.detail?.coordinateCount, 461);
  assert.equal(calls, callsBeforeReconcile + 1);

  // 3. 反过来：在我的记录按 R 刷新时，H 里的 done / review 任务也同步拿到最新核对状态
  const reviewTask: Task = structuredClone(task);
  reviewTask.id = 'review-task-1';
  reviewTask.phase = 'review';
  reviewTask.audit = undefined;
  store.state.tasks.push(reviewTask);
  await engine.records(a.id);
  const syncedAudit = store.state.tasks.find(t => t.id === 'review-task-1')?.audit;
  assert.equal(syncedAudit?.found, true);
  assert.equal(syncedAudit?.record?.sportId, 'demo-record');
  assert.ok(beforeReopenCalls > 0);
  await engine.shutdown();
});

test('执行页状态流转文案前后一致，新主题动态记录准确，2003 续期后概览不锁冷却', async () => {
  const checkedAudit: TaskAudit = {
    checkedAt: Date.now(),
    found: true,
    record: { sportId: 's1', isValid: '1', checkStatus: '1', inValidReason: '' } as unknown as NonNullable<TaskAudit['record']>,
  };
  const doneTask = {
    phase: 'done',
    note: '提交完成。',
    result: { accepted: true, businessValid: false, isValid: '1', checkStatus: '0' },
  } as unknown as Task;
  assert.equal(taskSummary(doneTask), '提交成功 · 待审核');
  assert.equal(taskSummary(doneTask, { kind: 'result', audit: checkedAudit }), '提交成功 · 已通过');
  doneTask.audit = checkedAudit;
  assert.equal(taskSummary(doneTask), '提交成功 · 已通过');

  const reviewTask = {
    phase: 'review',
    note: '上次提交中断，按 C 查看结果。',
    session: { sportId: 's1' },
  } as unknown as Task;
  assert.equal(taskSummary(reviewTask), '上次提交中断，结果待核对。');
  reviewTask.audit = checkedAudit;
  assert.equal(taskSummary(reviewTask), '核对结果 · 已通过');

  // 新配色动态不再误记为 Astolfo
  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  await engine.setColorTheme('mescaline');
  assert.equal(activityText(store.state.activity!.at(-1)!), '配色 · Mescaline');
  await engine.setColorTheme('acid');
  assert.equal(activityText(store.state.activity!.at(-1)!), '配色 · Acid');

  // 概览遇到 2003 停止批次后，不锁死 60 秒冷却
  let expireFirst = true;
  const e2 = new Engine(store, async (input, init) => {
    if (expireFirst && String(input).includes('/currentTimeMillis')) {
      expireFirst = false;
      return Response.json({ code: 2003, data: null });
    }
    return demoFetch(input, init);
  });
  await e2.initialize();
  await e2.checkSchool();
  const a = store.state.accounts[0]!;
  const failed = await e2.information(a.id, true);
  assert.equal(failed.clock.code, 2003);
  const ok = await e2.information(a.id, true);
  assert.equal(ok.statistics.data?.count, 12);
  await engine.shutdown();
  await e2.shutdown();
});
