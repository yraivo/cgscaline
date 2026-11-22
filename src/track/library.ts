import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { loadAnySportSource, pullSportDatasetFromPhone, stripInputQuotes, type ExtractedAndroidSession } from '../campus/android-import.js';
import { perturbRun, replayRecordToUploadJsonSports } from './mapper.js';
import type { RouteConfig, RunRecord } from './types.js';
import { alignBodyToNow } from '../protocol/align.js';
import { generateSensor } from '../protocol/sensor.js';
import { validateSaveJson } from '../protocol/validate.js';
import { identity, phoneVersion, UserError, type Account, type Library, type Prepared, type SourceMode, type OneShotTargets } from '../core/model.js';
import type { Store } from '../runtime/storage.js';
import { fitRun, validateTargets, durationText } from './fit.js';

export interface LibraryData { runs: RunRecord[]; sensors: Record<string, number[]>; routes?: RouteConfig[] }
export { canUseLibrary as canUse } from '../core/model.js';
import { canUseLibrary as canUse } from '../core/model.js';

async function readJson(path: string) {
  if ((await stat(path)).size > 80_000_000) throw new UserError('导入文件超过 80MB。');
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new UserError('数据文件不是有效 JSON。'); }
}
function hydrateAccountSessionFromBackup(store: Store, session: ExtractedAndroidSession | undefined, ownerId?: string) {
  if (!session?.token || !session.secret) return;
  const target = store.state.accounts.find(a =>
    (!a.session || a.session.status === 'invalid') &&
    ((session.xh && a.username === session.xh) || (ownerId && a.id === ownerId && !session.xh)),
  );
  if (!target) return;
  target.session = {
    id: randomUUID(),
    token: session.token,
    secret: session.secret,
    loginOutTime: session.loginOutTime,
    xh: target.username,
    name: session.name ?? '',
    gender: session.gender ?? '1',
    identity: identity(target),
    createdAt: Date.now(),
    status: 'saved',
  };
}

function resolveLibrarySchoolMeta(store: Store, owner?: string): { schoolBaseUrl?: string; schoolName?: string } {
  const ownerAcc = owner ? store.state.accounts.find(a => a.id === owner) : undefined;
  const uniqBases = [...new Set(store.state.accounts.map(a => a.school.baseUrl).filter(Boolean))];
  const ref = ownerAcc?.school ?? (uniqBases.length === 1 ? store.state.accounts[0]?.school : undefined);
  if (!ref) return {};
  return {
    // 仅对真实第三方校区网关标记归属，避免通用离线测试桩受影响
    ...(ref.baseUrl && ref.baseUrl !== 'https://cgapp.chingo.cn/cgapp-server/' ? { schoolBaseUrl: ref.baseUrl } : {}),
    ...(ref.name ? { schoolName: ref.name } : {}),
  };
}

export async function importLibrary(store: Store, file: string, label: string, scope: SourceMode, owner?: string): Promise<Library> {
  if (scope === 'private' && !store.state.accounts.some(a => a.id === owner)) throw new UserError('私有记录库必须选择所属账号。');
  const cleanedFile = stripInputQuotes(file);
  const { dataset: parsed, sensors: rawSensors, session: backupSession } = await loadAnySportSource(cleanedFile);
  hydrateAccountSessionFromBackup(store, backupSession, owner);
  const sensors: Record<string, number[]> = { ...rawSensors };
  try {
    const resolvedPath = await realpath(cleanedFile);
    const root = dirname(resolvedPath);
    const manifest = await readJson(resolve(root, 'sensor_manifest.json')) as { items: Array<{ matchedRunId: number; url: string }> };
    if (Array.isArray(manifest.items)) for (const item of manifest.items) {
      if (!Number.isFinite(item.matchedRunId) || typeof item.url !== 'string' || !item.url.startsWith('/data/sensors/')) continue;
      const candidate = await realpath(resolve(root, item.url.slice('/data/'.length)));
      const rel = relative(root, candidate);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      const arr = await readJson(candidate);
      if (Array.isArray(arr) && arr.length < 100_000 && arr.every(v => typeof v === 'number' && Number.isFinite(v))) sensors[String(item.matchedRunId)] = arr;
    }
  } catch { /* 可选本地传感器没有时沿用已有 One-Shot 的生成路径。 */ }
  const schoolMeta = resolveLibrarySchoolMeta(store, owner);
  const library: Library = { id: randomUUID(), label, scope, ...(scope === 'private' ? { ownerAccountId: owner } : {}),
    ...schoolMeta,
    runCount: parsed.runs.length, routeIds: [...new Set(parsed.runs.map(r => r.routeId!))], importedAt: Date.now() };
  const routes = Array.isArray(parsed.routes) ? parsed.routes : undefined;
  await store.putLibrary(library.id, { runs: parsed.runs, sensors, ...(routes ? { routes } : {}) } satisfies LibraryData);
  store.state.libraries.push(library); await store.save();
  return library;
}

export async function importLibraryFromPhone(store: Store, label: string, scope: SourceMode, owner?: string): Promise<Library & { sourceHint: string }> {
  if (scope === 'private' && !store.state.accounts.some(a => a.id === owner)) throw new UserError('私有记录库必须选择所属账号。');
  const { dataset: parsed, sensors, sourceHint, session: backupSession } = await pullSportDatasetFromPhone();
  hydrateAccountSessionFromBackup(store, backupSession, owner);
  const schoolMeta = resolveLibrarySchoolMeta(store, owner);
  const library: Library = {
    id: randomUUID(),
    label,
    scope,
    ...(scope === 'private' ? { ownerAccountId: owner } : {}),
    ...schoolMeta,
    runCount: parsed.runs.length,
    routeIds: [...new Set(parsed.runs.map(r => r.routeId!))],
    importedAt: Date.now(),
  };
  const routes = Array.isArray(parsed.routes) ? parsed.routes : undefined;
  await store.putLibrary(library.id, { runs: parsed.runs, sensors, ...(routes ? { routes } : {}) } satisfies LibraryData);
  store.state.libraries.push(library);
  await store.save();
  return { ...library, sourceHint };
}

export interface PrepareOptions extends OneShotTargets { runId?: number; seed?: number; avoidRunId?: number; avoidSeed?: number; mode?: 'auto' | 'legacy' }
/** Auto and manual share the same statistics reconstruction. Legacy is diagnostic only. */
export async function prepareOneShot(store: Store, a: Account, libraryId: string, options: PrepareOptions = {}): Promise<Prepared> {
  validateTargets(options);
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)) throw new UserError('随机种子需为无符号 32 位整数。');
  const library = store.state.libraries.find(l => l.id === libraryId);
  if (!library || !canUse(library, a)) throw new UserError('当前账号不能使用该记录库。');
  const data = await store.getLibrary<LibraryData>(libraryId);
  const sameRoute = data.runs.filter(r => r.routeId === a.routeId && (r.distanceKm ?? 0) >= 3 &&
    r.points.length >= 200 && r.points.every(p => Number.isFinite(p.latGcj02) && Number.isFinite(p.lngGcj02) &&
      Math.abs(p.latGcj02!) <= 90 && Math.abs(p.lngGcj02!) <= 180));
  const preferred = sameRoute.filter(r => (r.durationSec ?? 0) >= 840 && (r.durationSec ?? 0) <= 1800);
  const targets: OneShotTargets = { ...(options.distanceKm === undefined ? {} : { distanceKm: options.distanceKm }), ...(options.durationSec === undefined ? {} : { durationSec: options.durationSec }) };
  const custom = options.distanceKm !== undefined || options.durationSec !== undefined;
  const reconstruct = custom || options.mode !== 'legacy';
  let pool = custom ? sameRoute : preferred.length ? preferred : sameRoute;
  if (!pool.length) throw new UserError('该记录库没有符合条件的同路线样本。');
  if (options.runId !== undefined) { pool = pool.filter(r => r.id === options.runId); if (!pool.length) throw new UserError('诊断样本不在符合条件的同路线池中。'); }
  let seed = options.seed ?? randomInt(10_000, 100_000);
  if (options.seed === undefined && seed === options.avoidSeed) seed = seed === 99999 ? 10000 : seed + 1;
  let chosen: RunRecord, run: RunRecord, fitted: ReturnType<typeof fitRun> | undefined, candidateCount = pool.length;
  if (reconstruct) {
    const candidates: Array<{ source: RunRecord; fit: ReturnType<typeof fitRun>; score: number }> = [];
    const failures = new Set<string>();
    for (const source of pool) {
      try {
        const perturbed = perturbRun(source, seed);
        let actualTargets = targets;
        if (!custom) {
          const initial = fitRun(perturbed, {}, source.distanceKm!);
          if (Math.abs(initial.sourceWindowSec - (source.durationSec ?? 0)) > Math.max(10, initial.sourceWindowSec * .03))
            throw new UserError('样本存在较长暂停，自动模式暂不使用。');
          let n = (seed ^ Math.imul(source.id, 2654435761)) >>> 0;
          const random = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296; };
          const total = perturbed.points.at(-1)!.distanceTotalM!, low = Math.min(total, Math.max(3020, total * .98));
          const metres = Math.floor((low + (total - low) * random()) / 10) * 10;
          const distanceKm = metres >= 3020 && metres <= total ? metres / 1000 : undefined;
          const cropped = fitRun(perturbed, { distanceKm }, source.distanceKm!);
          actualTargets = { distanceKm, durationSec: Math.round(cropped.sourceWindowSec * (.94 + .12 * random())) };
        }
        const fit = fitRun(perturbed, actualTargets, source.distanceKm!);
        candidates.push({ source, fit, score: Math.abs(fit.timeScale - 1) + Math.abs(fit.run.points.length / source.points.length - 1) });
      } catch (error) { if (!(error instanceof UserError)) throw error; failures.add(error.message); }
    }
    candidateCount = candidates.length;
    if (!candidateCount) {
      const distances = pool.map(r => r.distanceKm!), times = pool.map(r => r.durationSec ?? 0);
      throw new UserError(`没有支持此目标的同路线样本。来源 ${Math.min(...distances).toFixed(2)}–${Math.max(...distances).toFixed(2)} km / ${durationText(Math.min(...times))}–${durationText(Math.max(...times))}。${[...failures].slice(0, 2).join('；')}`);
    }
    candidates.sort((a, b) => a.score - b.score);
    const near = custom ? candidates.slice(0, 3) : candidates, different = near.filter(c => c.source.id !== options.avoidRunId), choices = different.length ? different : near;
    const selected = choices[randomInt(choices.length)]!; chosen = selected.source; fitted = selected.fit; run = fitted.run;
  } else {
    const different = pool.filter(r => r.id !== options.avoidRunId), choices = different.length ? different : pool;
    chosen = choices[randomInt(choices.length)]!; run = perturbRun(chosen, seed);
  }
  const ruleName = a.information?.rules.data?.find(r => r.id === a.routeId)?.name;
  const mapped = replayRecordToUploadJsonSports(run, {
    uid: a.session?.xh ?? a.username, name: a.session?.name ?? '', routeId: a.routeId,
    ...(ruleName ? { planRouteName: ruleName } : {}),
    phoneVersion: phoneVersion(a.device),
  });
  if (fitted) mapped.lastOdometerTime = fitted.lastOdometerTime;
  if (reconstruct && Number(mapped.avgSpeed) > Number(mapped.maxSpeedPerHour) + .01) throw new UserError('目标平均速度超过当前映射器的最大速度，不能生成一致的统计。');
  const body = alignBodyToNow(mapped, { timezoneOffsetMin: 480 });
  if (String(body.routeId) !== a.routeId) throw new UserError('路线映射不一致。');
  const ts = (body.coordinate ?? []).map(p => p.t).filter(t => t > 0);
  const durationSec = (Math.max(...ts) - Math.min(...ts)) / 1000;
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 7200) throw new UserError('轨迹时间窗异常。');
  let sensor: number[] = [], sensorSource: Prepared['sensorSource'] = 'generated';
  const matched = data.sensors[String(chosen.id)];
  if (!reconstruct && matched && matched.length >= Math.floor((durationSec - 5) * 10) && Math.abs(matched.length / 10 - durationSec) <= 30) {
    sensor = matched.slice(0, Math.floor(durationSec * 10)); sensorSource = 'recorded';
  }
  if (!sensor.length) sensor = generateSensor({ durationSec, stepMinute: Number(body.stepMinute) || 145, ...(reconstruct ? { rngSeed: seed } : {}) });
  const errors = validateSaveJson({ ...body, sportId: 'PRECHECK-SID' }, { sensorSampleCount: sensor.length });
  if (errors.length) throw new UserError(`本地预检未通过：${errors.slice(0, 2).join('；')}`);
  return {
    body, sensor, routeId: a.routeId, libraryId, sourceRunId: chosen.id, sourceDistanceKm: chosen.distanceKm ?? undefined, sourceDurationSec: chosen.durationSec ?? undefined,
    candidateCount, accountIdentity: identity(a), seed, durationSec, sensorSource, generation: custom ? 'manual' : reconstruct ? 'auto' : 'legacy',
    ...(custom ? { targets } : {}), ...(fitted ? { fit: { sourceWindowSec: fitted.sourceWindowSec, timeScale: fitted.timeScale } } : {}),
  };
}
