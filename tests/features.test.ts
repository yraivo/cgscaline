import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAppClient } from '../src/app/local-client.js';
import { visualRenderers } from '../src/render/chroma.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { Engine } from '../src/runtime/engine.js';
import { extractMinimap } from '../src/render/minimap.js';
import { TaskNotifications } from '../src/runtime/notifications.js';
import { parseStart, termPlanSummary } from '../src/runtime/scheduling.js';
import { Store } from '../src/runtime/storage.js';
import { nextTaskDelay } from '../src/runtime/task-scheduler.js';
import { UIController } from '../src/ui/controller.js';
import { buildScene } from '../src/ui/scene.js';
import { stripAnsi } from '../src/ui/text.js';

test('进化 1：轨迹微缩投影（Minimap）归一化脱敏，在准备预览与运动详情右侧渲染', async () => {
  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  const client = new LocalAppClient(engine);
  const account = client.state.accounts[0]!;

  const draft1 = await client.commands.prepareDefault(account.id, { seed: 101 });
  const draft2 = await client.commands.prepareDefault(account.id, { seed: 202 });
  assert.equal('coordinate' in draft1.body, false);
  assert.equal('sensor' in draft1, false);
  assert.ok(draft1.minimap && draft1.minimap.length >= 20 && draft1.minimap.length <= 180);
  for (const [x, y, pace] of draft1.minimap!) {
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1 && pace >= 0 && pace <= 1);
  }

  const scene1 = buildScene(
    client.state,
    { screen: 'oneshot', selected: 0, accountId: account.id, preview: draft1, notice: '', motion: 1 },
    118,
    36,
    true,
    true,
  );
  const scene2 = buildScene(
    client.state,
    { screen: 'oneshot', selected: 0, accountId: account.id, preview: draft2, notice: '', motion: 1 },
    118,
    36,
    true,
    true,
  );
  const plain1 = scene1.body.map(stripAnsi).join('\n');
  assert.match(plain1, /ONE-SHOT \/ PREVIEW/);
  const rightBraille = scene1.body
    .slice(3, 28)
    .map(row => stripAnsi(row).slice(60))
    .join('');
  assert.match(rightBraille, /[\u2801-\u28ff]/u);
  assert.notEqual(scene1.body.join('\n'), scene2.body.join('\n'));

  const list = await client.commands.records(account.id);
  const detail = await client.commands.recordDetail(account.id, list[0]!.sportId, true);
  assert.ok(detail.minimap && detail.minimap.length >= 20);
  const detailScene = buildScene(
    client.state,
    {
      screen: 'records',
      selected: 0,
      accountId: account.id,
      title: '运动详情',
      detailRecord: list[0],
      detailMinimap: detail.minimap,
      lines: ['轨迹点  461'],
      notice: '',
      motion: 2,
    },
    118,
    36,
    true,
    true,
  );
  const detailRight = detailScene.body
    .slice(3, 28)
    .map(row => stripAnsi(row).slice(60))
    .join('');
  assert.match(detailRight, /[\u2801-\u28ff]/u);

  const tiny = extractMinimap([{ latitude: 30.55, longitude: 103.99 }]);
  assert.equal(tiny, undefined);
  await client.close();
});

test('进化 2：反应式致幻背景（TaskPulse）随在途任务进度与冲刺倒计时律动，界面显示实时百分比', async () => {
  for (const style of ['track', 'spiral'] as const) {
    const idle = visualRenderers[style](64, 24, 2, true, 'mescaline', 8, 65);
    const active = visualRenderers[style](64, 24, 2, true, 'mescaline', 8, 65, undefined, {
      progress: 0.72,
      countdownSec: 15,
      activeCount: 1,
    });
    assert.notDeepEqual(active.map(stripAnsi), idle.map(stripAnsi));
  }

  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  const client = new LocalAppClient(engine);
  const account = client.state.accounts[0]!;
  const draft = await client.commands.prepareDefault(account.id);
  const started = await client.commands.start(account.id, draft);
  const rawTask = store.state.tasks.find(t => t.id === started.id)!;
  const now = Date.now();
  rawTask.session!.startAtMs = now - 600_000;
  rawTask.session!.endAtMs = now + 400_000;
  rawTask.session!.commitAtLocalMs = now + 400_000;

  const homePlain = buildScene(
    client.state,
    { screen: 'home', selected: 0, notice: '', motion: 2 },
    118,
    36,
    false,
    true,
  )
    .body.map(stripAnsi)
    .join('\n');
  assert.match(homePlain, /进行中\s+\d+%/);
  await client.close();
});

test('进化 3：提交返回待审核时单次延迟自动静默复核，结果落地后触发系统通知且不循环轮询', async () => {
  const store = new Store(null);
  await seedDemo(store);
  let checkStatus = '0';
  let sportlistCalls = 0;

  const engine = new Engine(store, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/savesports')) {
      const res = await demoFetch(input, init);
      const body = (await res.json()) as { code: number; data: Record<string, unknown> };
      body.data = { ...body.data, isValid: '1', checkStatus };
      return Response.json(body);
    }
    if (url.pathname.endsWith('/sportlist')) {
      sportlistCalls++;
      const sportId = store.state.tasks[0]?.session?.sportId ?? 'demo-sport';
      return Response.json({
        code: 200,
        message: 'SUCCESS',
        data: [
          {
            sportId,
            routeId: '27',
            odometer: '3.05',
            activeTime: '00:19:12',
            beginTime: '2026-11-13 18:00:00',
            endTime: '2026-11-13 18:19:12',
            isValid: '1',
            checkStatus,
            inValidReason: '',
          },
        ],
      });
    }
    return demoFetch(input, init);
  });
  await engine.initialize();

  const notifications: string[] = [];
  const notifier = new TaskNotifications(store.state, msg => notifications.push(msg));
  const onChange = () => notifier.update(store.state);
  engine.on('change', onChange);

  try {
    const account = store.state.accounts[0]!;
    const task = await engine.start(account.id, await engine.prepareDefault(account.id));
    await engine.fastForwardDemo(task.id);
    notifier.flush();

    assert.equal(task.phase, 'done');
    assert.ok(task.autoAuditAt && task.autoAuditAt > Date.now() + 9 * 60_000);
    assert.equal(nextTaskDelay(store.state, Date.now()), 30_000);
    assert.equal(sportlistCalls, 0);

    // Simulate delayed auto-audit firing after platform completes async review.
    checkStatus = '1';
    task.autoAuditAt = Date.now() - 1000;
    await engine.tick();
    notifier.flush();

    assert.equal(sportlistCalls, 1);
    assert.equal(task.autoAuditAt, undefined);
    assert.equal(nextTaskDelay(store.state, Date.now()), undefined);
    assert.equal(task.audit?.found, true);
    assert.equal(task.audit?.record?.checkStatus, '1');
    assert.ok(notifications.some(m => /审核更新.*已通过/.test(m)));

    // Subsequent ticks never poll sportlist again.
    await engine.tick();
    assert.equal(sportlistCalls, 1);
  } finally {
    engine.off('change', onChange);
    notifier.close();
    await engine.shutdown();
  }
});

test('进化 4：学期进度智能排程建议与自然随机窗口定时（17:20-18:10 / ±抖动 / 智能）', async () => {
  const baseNow = Date.UTC(2026, 10, 13, 8, 0, 0); // 2026-11-13 16:00:00 +08:00
  const winLo = parseStart('17:20-18:10', baseNow, () => 0);
  const winHi = parseStart('17:20-18:10', baseNow, () => 1);
  const winMid = parseStart('17:20-18:10', baseNow, () => 0.37);
  assert.equal(winHi - winLo, 50 * 60_000);
  assert.ok(winMid > winLo && winMid < winHi);

  const pmLo = parseStart('21:30±10', baseNow, () => 0);
  const pmHi = parseStart('21:30±10', baseNow, () => 1);
  assert.equal(pmHi - pmLo, 20 * 60_000);

  const autoDay = parseStart('智能', baseNow, () => 0.5);
  assert.ok(autoDay >= baseNow + 3 * 60_000 && autoDay <= baseNow + 15 * 60_000);

  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  const account = store.state.accounts[0]!;
  await engine.information(account.id, true);
  await engine.configureSettings({ termTarget: 35 });

  const plan = termPlanSummary(account, store.state.settings.termTarget, baseNow);
  assert.ok(plan);
  assert.equal(plan!.completed, 12);
  assert.equal(plan!.target, 35);
  assert.equal(plan!.remaining, 23);
  assert.ok((plan!.daysLeft ?? 0) > 30);
  assert.ok((plan!.weeklyPace ?? 0) > 0);
  assert.match(plan!.line, /进度 12\/35 次.*还差 23 次.*建议每周/);

  const donePlan = termPlanSummary(account, 10, baseNow);
  assert.match(donePlan!.line, /已达标/);
  await engine.shutdown();
});

test('进化 5：往期归档（type=0）零请求 Tab 切换 + 单文件加密备份包（.cgsbak）跨实例迁移与防篡改', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'cgs-evol-a-'));
  const dirB = await mkdtemp(join(tmpdir(), 'cgs-evol-b-'));
  const backupFile = join(dirA, 'migration.cgsbak');
  const seenTypes: string[] = [];

  try {
    const storeA = new Store(dirA);
    await seedDemo(storeA);
    const engineA = new Engine(storeA, async (input, init) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/sportlist')) seenTypes.push(u.searchParams.get('type') ?? '');
      return demoFetch(input, init);
    });
    await engineA.initialize();
    await engineA.configureSettings({ termTarget: 42 });

    const clientA = new LocalAppClient(engineA);
    const ui = new UIController(clientA, true, true, false);
    ui.start();
    const account = clientA.state.accounts[0]!;
    ui.view.accountId = account.id;
    ui.navigate('history');
    ui.view.historyScope = 'current';

    const firstSportId = () => ui.view.history?.[0]?.sportId;

    await ui.workouts.run('refresh-history');
    assert.deepEqual(seenTypes, ['1']);
    assert.equal(firstSportId(), 'demo-record');

    // Tab switches to archive passively with zero network calls.
    await ui.workouts.run('toggle-scope');
    assert.equal(ui.view.historyScope, 'archive');
    assert.equal(seenTypes.length, 1);
    assert.equal(ui.view.history, undefined);

    // Refreshing on archive scope fetches type=0 and keeps current scope intact.
    await ui.workouts.run('refresh-history');
    assert.deepEqual(seenTypes, ['1', '0']);
    assert.equal(firstSportId(), 'demo-archive-record');

    // Tab back to current scope restores cached current list with zero network calls.
    await ui.workouts.run('toggle-scope');
    assert.equal(ui.view.historyScope, 'current');
    assert.equal(seenTypes.length, 2);
    assert.equal(firstSportId(), 'demo-record');
    await ui.close();

    // Export encrypted single-file backup (.cgsbak) and verify no plaintext token leaks.
    const exported = await engineA.exportBackup(backupFile, 'correct-horse-battery', true);
    assert.equal(exported.accounts, storeA.state.accounts.length);
    assert.equal(exported.libraries, storeA.state.libraries.length);
    const rawBackup = await readFile(backupFile, 'utf8');
    assert.equal(rawBackup.includes(storeA.state.accounts[0]!.username), false);
    assert.equal(rawBackup.includes('demo.payload.signature'), false);

    // Import into a brand-new Store(dirB) and verify wrong passphrase & tampering fail cleanly.
    const storeB = new Store(dirB);
    await storeB.open();
    const engineB = new Engine(storeB, demoFetch);
    await engineB.initialize();

    await assert.rejects(engineB.importBackup(backupFile, 'wrong-passphrase-123'), /口令错误|损坏/);

    const tamperedFile = join(dirA, 'tampered.cgsbak');
    const parsed = JSON.parse(rawBackup) as { ciphertext: string };
    const buf = Buffer.from(parsed.ciphertext, 'base64');
    buf[0]! ^= 0xff;
    parsed.ciphertext = buf.toString('base64');
    await writeFile(tamperedFile, JSON.stringify(parsed), 'utf8');
    await assert.rejects(engineB.importBackup(tamperedFile, 'correct-horse-battery'), /口令错误|损坏/);

    const imported = await engineB.importBackup(backupFile, 'correct-horse-battery');
    assert.equal(imported.accountsAdded, storeA.state.accounts.length);
    assert.equal(imported.librariesAdded, storeA.state.libraries.length);
    assert.equal(storeB.state.settings.termTarget, 42);
    assert.equal(storeB.state.accounts[0]?.session?.status, 'saved');
    const draftB = await engineB.prepareDefault(storeB.state.accounts[0]!.id);
    assert.ok(draftB.body.coordinate && draftB.body.coordinate.length > 100);

    await engineA.shutdown();
    await engineB.shutdown();
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
