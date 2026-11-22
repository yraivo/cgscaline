import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAppClient } from '../src/app/local-client.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { Engine } from '../src/runtime/engine.js';
import { geometryErrors } from '../src/track/geometry.js';
import { pointInPolygon, distanceMeters } from '../src/track/geo.js';
import { perturbRun, replayRecordToUploadJsonSports } from '../src/track/mapper.js';
import { fitRun } from '../src/track/fit.js';
import type { GcjCoord, RunRecord, TrackPoint } from '../src/track/types.js';
import { isCleanSourceRun, type LibraryData } from '../src/track/library.js';
import { validateSaveJson } from '../src/protocol/validate.js';
import { Store } from '../src/runtime/storage.js';
import { UIController } from '../src/ui/controller.js';
import { buildScene } from '../src/ui/scene.js';
import { stripAnsi } from '../src/ui/text.js';
import { connectWorker, runWorker } from '../src/runtime/worker.js';

const SYNTH_STADIUM_27: GcjCoord[] = [
  [31.202498, 121.407989],
  [31.202194, 121.406797],
  [31.203931, 121.406309],
  [31.204222, 121.407532],
  [31.202498, 121.407989],
];

function buildRealisticDirtyStadiumRun(): RunRecord {
  const cLat = 31.20322, cLng = 121.40715;
  const baseTs = 1762504860000;
  const points: TrackPoint[] = [];

  // 0..1: 冷启动基站定位点（落在 280m 外的建筑墙体或水域中）
  points.push({
    id: 0, latGcj02: 31.20541, lngGcj02: 121.40915, timestampMs: 0,
    accuracyM: 0, distanceDeltaM: 0, distanceTotalM: 0, speedKmh: 0, stepDelta: 0, stepTotal: 0, validFlag: 0, usable: false,
  });
  points.push({
    id: 1, latGcj02: 31.20541, lngGcj02: 121.40915, timestampMs: baseTs + 1000,
    accuracyM: 550, distanceDeltaM: 0, distanceTotalM: 0, speedKmh: 0, stepDelta: 0, stepTotal: 0, validFlag: -1, usable: false,
  });

  let totalDist = 0;
  let totalSteps = 0;
  let prevLat = 0, prevLng = 0;
  const totalPts = 520;
  const tilt = -0.26;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);

  for (let k = 0; k < totalPts; k++) {
    const theta = (k / totalPts) * Math.PI * 2 * 7.6;
    let lx = 38 * Math.cos(theta);
    let ly = 74 * Math.sin(theta);
    if (k >= 95 && k <= 120) {
      const bulge = Math.sin(((k - 95) / 25) * Math.PI) * 6.5;
      const nrm = Math.hypot(lx, ly);
      lx += (lx / nrm) * bulge;
      ly += (ly / nrm) * bulge;
    }
    const rx = lx * cosT - ly * sinT;
    const ry = lx * sinT + ly * cosT;
    let lat = cLat + ry / 111000;
    let lng = cLng + rx / (111320 * Math.cos((cLat * Math.PI) / 180));

    const isWarmupZero = k < 2;
    const isPauseWalk = k >= 300 && k <= 310;
    const isCellSpike = k === 210 || k === 211;

    if (isCellSpike) {
      lat = 31.20465;
      lng = 121.40895;
    }

    let d = 0;
    if (k > 0 && !isWarmupZero && !isPauseWalk && !isCellSpike) {
      d = distanceMeters([prevLat, prevLng], [lat, lng]);
      if (k === 212) d = 6.0;
      totalDist += d;
    }
    if (!isCellSpike) {
      prevLat = lat;
      prevLng = lng;
    }
    const st = isWarmupZero || isPauseWalk || isCellSpike ? 0 : 5;
    totalSteps += st;
    points.push({
      id: k + 2,
      latGcj02: lat,
      lngGcj02: lng,
      timestampMs: baseTs + (k + 2) * 2000,
      accuracyM: isCellSpike ? 550 : 3.8,
      distanceDeltaM: d,
      distanceTotalM: totalDist,
      speedKmh: d > 0 ? Number(((d / 2) * 3.6).toFixed(2)) : 0,
      stepDelta: st,
      stepTotal: totalSteps,
      validFlag: isCellSpike ? -1 : isPauseWalk ? 0 : 1,
      usable: !isCellSpike && !isPauseWalk,
    });
  }

  const durationSec = Math.round(((points.at(-1)!.timestampMs! - points[1]!.timestampMs!) / 1000));
  return {
    id: 901,
    sportId: 'dirty-stadium-run',
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

test('修复 1：轨迹清洗与切向/法向走廊微扰消除冷启动穿墙、途中掉线尖峰、d=0 冻结拉弦与越界外飘', async () => {
  const dirty = buildRealisticDirtyStadiumRun();
  assert.equal(pointInPolygon([dirty.points[0]!.latGcj02!, dirty.points[0]!.lngGcj02!], SYNTH_STADIUM_27), false);

  for (let seed = 50001; seed <= 50015; seed++) {
    const out = perturbRun(dirty, seed, SYNTH_STADIUM_27);

    for (let i = 0; i < out.points.length; i++) {
      const p = out.points[i]!;
      assert.equal(
        pointInPolygon([p.latGcj02!, p.lngGcj02!], SYNTH_STADIUM_27),
        true,
        `seed=${seed} point[${i}] (${p.latGcj02}, ${p.lngGcj02}) escaped stadium fence`,
      );
      assert.notEqual(p.validFlag, -1, `seed=${seed} point[${i}] still has v=-1 red spike`);
    }

    for (let i = 1; i < out.points.length; i++) {
      const a = out.points[i - 1]!, b = out.points[i]!;
      const stepM = distanceMeters([a.latGcj02!, a.lngGcj02!], [b.latGcj02!, b.lngGcj02!]);
      assert.ok(stepM < 18, `seed=${seed} step ${i - 1}->${i} jumped ${stepM.toFixed(1)}m`);
    }

    const rawBulge = dirty.points[108]!;
    const fixedBulge = out.points[108]!;
    const center: GcjCoord = [31.20322, 121.40715];
    assert.ok(
      distanceMeters([fixedBulge.latGcj02!, fixedBulge.lngGcj02!], center) <
        distanceMeters([rawBulge.latGcj02!, rawBulge.lngGcj02!], center) - 2.5,
    );

    const body = replayRecordToUploadJsonSports(out, { uid: '20240001' });
    assert.deepEqual(validateSaveJson({ ...body, beginTime: '2026-11-18 19:00:00', endTime: '2026-11-18 19:17:24', sportId: 'SID-1' }), []);
    assert.deepEqual(
      geometryErrors({
        body,
        sensor: [],
        routeId: '27',
        libraryId: 'lib',
        sourceRunId: dirty.id,
        sourceDistanceKm: dirty.distanceKm!,
        seed,
        durationSec: dirty.durationSec!,
        sensorSource: 'generated',
      }),
      [],
    );
  }

  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  const a = store.state.accounts[0]!;
  const lib = store.state.libraries[0]!;
  const data = await store.getLibrary<LibraryData>(lib.id);
  const infieldCut = structuredClone(dirty);
  infieldCut.id = 999;
  for (let k = 400; k < 420; k++) {
    infieldCut.points[k]!.latGcj02 = 31.20322;
    infieldCut.points[k]!.lngGcj02 = 121.40715;
    infieldCut.points[k]!.validFlag = 1;
    infieldCut.points[k]!.accuracyM = 3.8;
  }
  assert.equal(isCleanSourceRun(infieldCut), false);
  data.runs.push(infieldCut);
  lib.runCount = data.runs.length;
  await store.putLibrary(lib.id, data);
  for (let s = 1; s <= 10; s++) {
    const prep = await engine.prepareDefault(a.id, { seed: 20000 + s });
    assert.notEqual(prep.sourceRunId, 999);
  }
  await engine.shutdown();
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
    if (worker) worker.close();
    await new Promise(r => setTimeout(r, 150));
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

test('回归 reason=24：平滑后略低于 3000m 的 3km 样本经真实走廊续跑补足 Haversine ≥3015m，绝不虚假放大 da', () => {
  // 构造一条模拟手机样条平滑后真实 Haversine ≈ 2982m（但标注 3.00km）的 8.4 圈田径场样本
  const cLat = 31.20322, cLng = 121.40715;
  const baseTs = 1762504860000;
  const tilt = -0.26, cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const pts: TrackPoint[] = [
    { id: 0, latGcj02: cLat, lngGcj02: cLng, timestampMs: 0, accuracyM: 0, distanceDeltaM: 0, distanceTotalM: 0, speedKmh: 0, stepDelta: 0, stepTotal: 0, validFlag: 0, usable: false },
  ];
  let dist = 0, steps = 0;
  const count = 560;
  for (let k = 0; k < count; k++) {
    const theta = (k / count) * Math.PI * 2 * 8.45;
    const lx = 37 * Math.cos(theta), ly = 73 * Math.sin(theta);
    const rx = lx * cosT - ly * sinT, ry = lx * sinT + ly * cosT;
    const lat = cLat + ry / 111000;
    const lng = cLng + rx / (111320 * Math.cos((cLat * Math.PI) / 180));
    const d = k === 0 ? 0 : distanceMeters([pts.at(-1)!.latGcj02!, pts.at(-1)!.lngGcj02!], [lat, lng]);
    dist += d;
    const st = k === 0 ? 0 : 5;
    steps += st;
    pts.push({
      id: k + 1,
      latGcj02: lat,
      lngGcj02: lng,
      timestampMs: baseTs + (k + 1) * 2000,
      accuracyM: 3.8,
      distanceDeltaM: d,
      distanceTotalM: dist,
      speedKmh: d > 0 ? Number(((d / 2) * 3.6).toFixed(2)) : 0,
      stepDelta: st,
      stepTotal: steps,
      validFlag: 1,
      usable: true,
    });
  }
  assert.ok(dist > 2940 && dist < 2999, `前置条件：原始几何总长应略低于 3000m，实际 ${dist.toFixed(1)}m`);
  const durSec = Math.round((pts.at(-1)!.timestampMs! - pts[1]!.timestampMs!) / 1000);
  const baseRun: RunRecord = {
    id: 902,
    sportId: 'short-smoothed-3k',
    routeId: '27',
    routeName: '2号田径场',
    startDate: '2026-11-18 19:00:00',
    endDate: '2026-11-18 19:18:40',
    distanceKm: 3.0,
    durationSec: durSec,
    totalSteps: steps,
    avgSpeedKmh: Number((3.0 / (durSec / 3600)).toFixed(2)),
    avgPace: "06'13''",
    stepMinute: Number((steps / (durSec / 60)).toFixed(2)),
    statusEvidence: {},
    points: pts,
    paceSplits: [{ km: 1, pace: "06'13''" }, { km: 2, pace: "06'13''" }, { km: 3, pace: "06'13''" }],
    minuteSpeeds: Array.from({ length: Math.floor(durSec / 60) }, (_, i) => ({ minute: i + 1, speed: 9.65 })),
  };

  for (let seed = 8101; seed <= 8115; seed++) {
    const pert = perturbRun(baseRun, seed, SYNTH_STADIUM_27);
    const fitted = fitRun(pert, { distanceKm: 3.02 }, 3.0);
    const body = replayRecordToUploadJsonSports(fitted.run, { uid: '20240001' });
    body.lastOdometerTime = fitted.lastOdometerTime;

    const coords = body.coordinate ?? [];
    let geoV1 = 0, geoDPos = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1]!, b = coords[i]!;
      const step = distanceMeters([a.a, a.o], [b.a, b.o]);
      if (b.v === 1) geoV1 += step;
      if (b.d > 0) geoDPos += step;
      assert.equal(pointInPolygon([b.a, b.o], SYNTH_STADIUM_27), true);
    }
    const daLast = coords.at(-1)!.da;
    assert.ok(geoV1 >= 3015, `期望真实有效 Haversine ≥3015m，实际 ${geoV1.toFixed(1)}m`);
    assert.ok(Math.abs(daLast - geoDPos) < 1.0, `期望 da 与真实 Haversine 零虚增（<1m），实际差 ${(daLast - geoDPos).toFixed(2)}m`);
    assert.deepEqual(
      geometryErrors({
        body,
        sensor: [],
        routeId: '27',
        libraryId: 'lib',
        sourceRunId: baseRun.id,
        sourceDistanceKm: 3.0,
        seed,
        durationSec: fitted.run.durationSec!,
        sensorSource: 'generated',
      }),
      [],
    );
  }
});
