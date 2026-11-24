import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { extractSportFilesFromTar, extractSportFilesFromZip, loadAnySportSource } from '../src/campus/android-import.js';
import { fetchInformation, fetchSchoolNotices } from '../src/campus/information.js';
import { demoFetch, demoRun, demoSession, seedDemo } from '../src/core/demo.js';
import { newAccount } from '../src/core/model.js';
import { distanceMeters } from '../src/track/geo.js';
import { prepareOneShot, type LibraryData } from '../src/track/library.js';
import { Store } from '../src/runtime/storage.js';
import { login } from '../src/protocol/login.js';
import { fetchRecords } from '../src/protocol/records.js';
import { handleScheduledSubmit } from '../src/protocol/scheduled-submit.js';

function tar(files: Array<[string, string]>) {
  const blocks: Buffer[] = [];
  for (const [path, value] of files) {
    const data = Buffer.from(value), header = Buffer.alloc(512);
    header.write(path); header.write(data.length.toString(8).padStart(11, '0'), 124);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat(blocks);
}
function zip(name: string, bytes: Buffer, size = bytes.length) {
  const compressed = deflateRawSync(bytes), path = Buffer.from(name);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(path.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(path.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt32LE(central.length + path.length, 12);
  end.writeUInt32LE(local.length + path.length + compressed.length, 16);
  return Buffer.concat([local, path, compressed, central, path, end]);
}
const xml = (name: string, value: string) => '<map><string name="' + name + '">' + value + '</string></map>';

test('archives keep ownership hints with one database; duplicates drop hints, credentials never enter parsed data', () => {
  const root = 'snapshot-a/apps/net.crigh.cgsport/';
  const files: Array<[string, string]> = [
    [root + 'db/ygty_mysport.db', 'synthetic database'],
    [root + 'sp/USERINFO.xml', xml('USERXH', 'sample&#45;A')],
    [root + 'sp/SCHOOL.xml', xml('SERVERURL', 'https://school.invalid/app/')],
    [root + 'sp/umzid_general_config.xml', xml('uabc', '{&quot;model&quot;:&quot;Synthetic Model&quot;}')],
    [root + 'sp/HEADER.xml', xml('TOKEN', 'synthetic-private-value')],
    ['snapshot-b/apps/net.crigh.cgsport/sp/USERINFO.xml', xml('USERXH', 'other-user')],
    ['snapshot-a/apps/other.example/db/ygty_mysport.db', 'unrelated'],
  ];
  for (const snapshot of [extractSportFilesFromTar(tar(files)), extractSportFilesFromZip(zip('archive.tar', tar(files)))]) {
    assert.equal(snapshot.db?.toString(), 'synthetic database');
    assert.deepEqual(snapshot.hints, { username: 'sample-A', serverUrl: 'https://school.invalid/app/', model: 'Synthetic Model' });
    assert.equal(JSON.stringify(snapshot).includes('synthetic-private-value'), false);
  }
  const duplicate = extractSportFilesFromTar(tar([...files, [root + 'sp/USERINFO.xml', xml('USERXH', 'wrong')]]));
  assert.equal(duplicate.hints, undefined); assert.ok(duplicate.db);
  assert.throws(() => extractSportFilesFromTar(tar([...files, ['snapshot-b/db/ygty_mysport.db', 'second']])), /多个记录库/);
  assert.throws(() => extractSportFilesFromZip(zip('db/ygty_mysport.db', Buffer.from('sample'), 2)));
});

test('remote limits use the authenticated account, preserve timestamps across unrelated refreshes and stop on auth errors', async () => {
  const a = newAccount('Example', 'sample-A', 'tenant');
  a.school.baseUrl = 'https://campus.invalid/';
  a.session = demoSession(a);
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    if (!url.pathname.endsWith('/getConfig')) return demoFetch(input, init);
    assert.equal(url.searchParams.get('uid'), a.username);
    return Response.json({ code: 200, data: { app_account_imei: '7', app_imei_account: false } });
  };
  a.information = await fetchInformation(a, fetcher, 'school');
  const limits = a.information.deviceLimits?.data;
  assert.equal(limits?.devicesPerAccount, 7); assert.equal(limits?.accountsPerDevice, undefined);
  assert.ok(limits?.readAt);
  a.information = await fetchInformation(a, fetcher);
  a.information = await fetchSchoolNotices(a, fetcher);
  assert.deepEqual(a.information.deviceLimits?.data, limits);
  assert.equal(paths.filter(p => p.endsWith('/getConfig')).length, 1);
  const stopped: string[] = [];
  await fetchInformation(a, async input => { stopped.push(String(input)); return Response.json({ code: 2001 }); }, 'school');
  assert.equal(stopped.length, 1);
  assert.equal(a.session.status, 'invalid');
});

test('unpacked import does not follow sensor directory links outside the selected snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'archive-boundary-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const selected = join(root, 'selected'), elsewhere = join(root, 'other');
  await mkdir(selected); await mkdir(elsewhere);
  const source = { ...demoRun(), sportId: 'sample-run-001' };
  await writeFile(join(selected, 'success_dataset.json'), JSON.stringify({ coordinateSystem: 'GCJ-02', runs: [source] }));
  await writeFile(join(elsewhere, source.sportId + '.txt'), JSON.stringify(Array(20).fill(1)));
  await symlink(elsewhere, join(selected, 'sensor'), process.platform === 'win32' ? 'junction' : 'dir');
  const parsed = await loadAnySportSource(selected);
  assert.equal(parsed.dataset.runs.length, 1); assert.deepEqual(parsed.sensors, {});
});

test('missing device identity fails before any live protocol request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw Error('network'); };
  await assert.rejects(login('sample-A', 'synthetic', { fetchImpl: fetcher }), /设备/);
  await assert.rejects(fetchRecords({ xh: 'sample-A', token: '', secret: '', fetchImpl: fetcher }), /设备/);
  const baseUrl = 'https://campus.invalid/';
  const result = await handleScheduledSubmit({ body: {}, sportTypeId: 'sample', startAtMs: 1, sensorArray: [],
    config: { baseUrl, token: '', imei: '', version: '', client: '', signer: 'mock' } },
    { fetchImpl: fetcher, allowedOrigins: new Set([new URL(baseUrl).origin]) });
  assert.equal(result.ok, false); assert.equal(calls, 0);
});

test('raw geometry describes original adjacent valid fixes and never filters candidates', async () => {
  const store = new Store(null); await seedDemo(store);
  const a = store.state.accounts[0]!, lib = store.state.libraries[0]!;
  const source = demoRun(a.routeId);
  const data: LibraryData = { runs: [source], sensors: {} };
  await store.putLibrary(lib.id, data);
  const before = structuredClone(source);
  let metres = 0;
  for (let i = 1; i < source.points.length; i++) {
    const p = source.points[i - 1]!, q = source.points[i]!;
    if (p.validFlag === 1 && q.validFlag === 1 && p.timestampMs! > 0 && q.timestampMs! > 0)
      metres += distanceMeters([p.latGcj02!, p.lngGcj02!], [q.latGcj02!, q.lngGcj02!]);
  }
  assert.ok(metres > 0);
  const output = await prepareOneShot(store, a, lib.id, { distanceKm: 3, seed: 21 });
  assert.equal(output.rawGeometryMeters, metres); assert.equal(output.candidateCount, 1);
  assert.deepEqual((await store.getLibrary<LibraryData>(lib.id)).runs[0], before);
  await assert.rejects(prepareOneShot(store, a, lib.id, { distanceKm: 2.99 }), /3–100/);
  await assert.rejects(prepareOneShot(store, a, lib.id, { distanceKm: 6 }), /1 个候选/);
});
