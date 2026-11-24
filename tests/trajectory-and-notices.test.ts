import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAppClient } from '../src/app/local-client.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { Engine } from '../src/runtime/engine.js';
import { geometryErrors } from '../src/track/geometry.js';
import { distanceMeters } from '../src/track/geo.js';
import { perturbRun, replayRecordToUploadJsonSports } from '../src/track/mapper.js';
import type { RunRecord, TrackPoint } from '../src/track/types.js';
import { validateSaveJson } from '../src/protocol/validate.js';
import { Store } from '../src/runtime/storage.js';
import { UIController } from '../src/ui/controller.js';
import { buildScene } from '../src/ui/scene.js';
import { stripAnsi } from '../src/ui/text.js';
import { connectWorker, runWorker } from '../src/runtime/worker.js';

function buildRealisticStadiumRun(): RunRecord {
  const cLat = 31.20322, cLng = 121.40715;
  const baseTs = 1762504860000;
  const points: TrackPoint[] = [];

  // 0..1: 原生冷启动初始化与首次锁星点（保留 ac>=50 与 v=-1 真机特征，不可抹平）
  points.push({
    id: 0, latGcj02: cLat, lngGcj02: cLng, timestampMs: 0,
    accuracyM: 0, distanceDeltaM: 0, distanceTotalM: 0, speedKmh: 0, stepDelta: 0, stepTotal: 0, validFlag: 0, usable: false,
  });
  points.push({
    id: 1, latGcj02: cLat, lngGcj02: cLng, timestampMs: baseTs + 1000,
    accuracyM: 125, distanceDeltaM: 0, distanceTotalM: 0, speedKmh: 0, stepDelta: 0, stepTotal: 0, validFlag: -1, usable: false,
  });

  let totalDist = 0;
  let totalSteps = 0;
  let prevLat = cLat, prevLng = cLng;
  const totalPts = 520;
  const tilt = -0.26;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

  for (let k = 0; k < totalPts; k++) {
    const theta = (k / totalPts) * Math.PI * 2 * 7.6;
    const lx = 38 * Math.cos(theta);
    const ly = 74 * Math.sin(theta);
    const rx = lx * cosT - ly * sinT;
    const ry = lx * sinT + ly * cosT;
    const lat = cLat + ry / 111000;
    const lng = cLng + rx / (111320 * Math.cos((cLat * Math.PI) / 180));
    const isWarmupZero = k < 2;
    const d = k > 0 && !isWarmupZero ? distanceMeters([prevLat, prevLng], [lat, lng]) : 0;
    totalDist += d;
    prevLat = lat;
    prevLng = lng;
    const st = isWarmupZero ? 0 : 5;
    totalSteps += st;
    points.push({
      id: k + 2,
      latGcj02: lat,
      lngGcj02: lng,
      timestampMs: baseTs + (k + 2) * 2000,
      accuracyM: 3.8,
      distanceDeltaM: d,
      distanceTotalM: totalDist,
      speedKmh: d > 0 ? Number(((d / 2) * 3.6).toFixed(2)) : 0,
      stepDelta: st,
      stepTotal: totalSteps,
      validFlag: 1,
      usable: true,
    });
  }

  const durationSec = Math.round((points.at(-1)!.timestampMs! - points[1]!.timestampMs!) / 1000);
  return {
    id: 901,
    sportId: 'stadium-run',
    routeId: '27',
    routeName: '2号田径场',
    startDate: '2026-11-18 19:00:00',
    endDate: '2026-11-18 19:17:24',
    distanceKm: Number((totalDist / 1000).toFixed(2)),
    durationSec,
    totalSteps,
    avgSpeedKmh: Number(((totalDist / 1000) / (durationSec / 3600)).toFixed(2)),
    avgPace: "05'42''",
    stepMinute: Number((totalSteps / (durationSec / 60)).toFixed(2)),
    statusEvidence: {},
    points,
    paceSplits: [
      { km: 1, pace: "05'42''" },
      { km: 2, pace: "05'42''" },
      { km: 3, pace: "05'42''" },
    ],
    minuteSpeeds: Array.from({ length: Math.floor(durationSec / 60) }, (_, i) => ({ minute: i + 1, speed: 10.5 })),
  };
}

test('修复 1：OU(σ=1m) 轨迹物理微扰完整保留真机冷启动锁星特征（v=-1 / ac>=50）与静止点零位移', () => {
  const sample = buildRealisticStadiumRun();
  for (let seed = 50001; seed <= 50015; seed++) {
    const out = perturbRun(sample, seed);
    assert.equal(out.points[1]!.validFlag, -1);
    assert.equal(out.points[1]!.accuracyM, 125);
    assert.equal(out.points[1]!.distanceDeltaM, 0);

    const body = replayRecordToUploadJsonSports(out, { uid: '20240001' });
    assert.equal(body.coordinate![0]!.t, 0);
    assert.equal(body.coordinate![1]!.v, -1);
    assert.equal(body.coordinate![1]!.ac, 125);
    assert.deepEqual(validateSaveJson({ ...body, beginTime: '2026-11-18 19:00:00', endTime: '2026-11-18 19:17:24', sportId: 'SID-1' }), []);
    assert.deepEqual(
      geometryErrors({
        body,
        sensor: [],
        routeId: '27',
        libraryId: 'lib',
        sourceRunId: sample.id,
        sourceDistanceKm: sample.distanceKm!,
        seed,
        durationSec: sample.durationSec!,
        sensorSource: 'generated',
      }),
      [],
    );
  }
});

test('修复 2：我的记录「本学期」在真实后台 Worker IPC 下按 R 刷新不再报「记录范围无效」', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cgs-scope-ipc-'));
  let worker: Awaited<ReturnType<typeof runWorker>> | undefined;
  try {
    worker = await runWorker(root, true, false);
    const accId = worker.engine.store.state.accounts[0]!.id;
    await worker.engine.checkSchool();
    const directRows = await worker.engine.records(accId, null);
    assert.equal(directRows[0]?.sportId, 'demo-record');

    const remote = await connectWorker(root, { demo: true, start: false, notifications: false });
    const ui = new UIController(remote, true, true, false);
    ui.start();
    ui.view.accountId = accId;
    ui.navigate('history');
    ui.view.historyScope = 'current';

    await ui.workouts.run('refresh-history');
    assert.equal(ui.view.notice, '');
    assert.equal(ui.view.history?.[0]?.sportId, 'demo-record');

    await ui.workouts.run('toggle-scope');
    assert.equal(ui.view.historyScope, 'archive');
    await ui.workouts.run('refresh-history');
    assert.equal(ui.view.notice, '');
    assert.equal(ui.view.history?.[0]?.sportId, 'demo-archive-record');

    await ui.workouts.run('toggle-scope');
    assert.equal(ui.view.historyScope, 'current');
    assert.equal(ui.view.history?.[0]?.sportId, 'demo-record');

    await ui.close();
  } finally {
    if (worker) await worker.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('修复 3：接入学校通知双接口（/activity + /notifications），支持主页 N 查看、详情正文解析且外部链接不泄露凭据', async () => {
  const store = new Store(null);
  await seedDemo(store);
  const seenRequests: Array<{ url: string; hasAuth: boolean }> = [];
  const engine = new Engine(store, async (input, init) => {
    const u = String(input);
    const h = new Headers(init?.headers);
    seenRequests.push({ url: u, hasAuth: h.has('cgAuthorization') || h.has('imei') });
    return demoFetch(input, init);
  });
  await engine.initialize();
  await engine.checkSchool();
  seenRequests.length = 0;

  const client = new LocalAppClient(engine);
  const ui = new UIController(client, true, true, false);
  ui.start();

  ui.handle('n', { name: 'n', ctrl: false, meta: false });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ui.view.screen, 'notices');
  assert.equal(seenRequests.length, 0);

  const emptyScene = buildScene(client.state, ui.view, 118, 34, false, true).body.map(stripAnsi).join('\n');
  assert.match(emptyScene, /学校通知 · 校区运动中心/);
  assert.match(emptyScene, /按 R 刷新/);

  ui.handle('r', { name: 'r', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(seenRequests.length, 2);
  assert.ok(seenRequests.some(r => r.url.includes('/api/l/v6/activity?page=-1')));
  assert.ok(seenRequests.some(r => r.url.includes('/api/l/v6/notifications?page=-1&size=-1')));

  const listScene = buildScene(client.state, ui.view, 118, 34, false, true).body.map(stripAnsi).join('\n');
  assert.match(listScene, /\[重要\].*公共体育课课外锻炼通知/);
  assert.match(listScene, /运动场开放时段调整提醒/);

  const homeScene = buildScene(client.state, { screen: 'home', selected: 0, notice: '' }, 118, 38, false, true)
    .body.map(stripAnsi)
    .join('\n');
  assert.match(homeScene, /学校通知/);
  assert.match(homeScene, /公共体育课课外锻炼通知/);

  ui.handle('\r', { name: 'return', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(ui.view.screen, 'records');
  assert.equal(ui.view.title, '通知详情');
  assert.ok(ui.view.lines?.some(l => l.includes('有效单次距离不少于 3.0 公里')));

  ui.handle('\x1b', { name: 'escape', ctrl: false, meta: false });
  assert.equal(ui.view.screen, 'notices');
  const countBeforeExternal = seenRequests.length;
  ui.view.selected = 1;
  ui.handle('\r', { name: 'return', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(ui.view.screen, 'records');
  assert.equal(seenRequests.length, countBeforeExternal);
  assert.ok(ui.view.lines?.some(l => l.includes('https://portal.campus.example.edu/')));
  assert.ok(seenRequests.every(r => !r.url.includes('portal.campus.example.edu')));

  await ui.close();
  await client.close();
});
