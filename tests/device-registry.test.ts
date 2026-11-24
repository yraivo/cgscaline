import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/runtime/storage.js';
import { FileDeviceRegistry, MemoryDeviceRegistry, registryForWorker } from '../src/runtime/device-registry.js';
import { LEGACY_ANDROID_ID } from '../src/core/device-identity.js';
import { deviceHeaders, identity, migrateIdentity, newAccount } from '../src/core/model.js';
import { appState } from '../src/app/projection.js';
import { demoSession } from '../src/core/demo.js';
import { runWorker } from '../src/runtime/worker.js';
import { LocalAppClient } from '../src/app/local-client.js';
import { UIController } from '../src/ui/controller.js';
import { SnapshotCollector, parseUmengItCache } from '../src/campus/backup-snapshot.js';

const exec = promisify(execFile);
const clearVault = { protect: async (b: Buffer) => b, unprotect: async (b: Buffer) => b };
const school = { baseUrl: 'https://campus.invalid/api/', id: 'tenant', code: 'test', name: 'Test Campus',
  nameEn: 'Test Campus', provinceCode: '', randomCode: '' };
const offline = async (): Promise<Response> => { throw new Error('unexpected network'); };
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'device-registry-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return root;
}

test('independent processes serialize creation and recover the OS lock after writer death', async t => {
  const root = await temp(t);
  const launch = (dir: string, account: string, mode?: string) => exec(process.execPath, ['--import', 'tsx',
    resolve('tests/fixtures/registry-worker.ts'), root, dir, account, ...(mode ? [mode] : [])], { timeout: 45_000 });
  const [a, b, c] = await Promise.all([launch('first', 'sample-A'), launch('second', 'sample-A'), launch('third', 'sample-B')]);
  assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
  assert.notEqual(JSON.parse(a.stdout).androidId, JSON.parse(c.stdout).androidId);
  await assert.rejects(launch('interrupted', 'sample-C', 'crash-before-replace'), { code: 37 });
  await launch('restarted', 'sample-C');
  const registry = new FileDeviceRegistry(join(root, 'registry'), clearVault);
  assert.equal(await registry.transaction(table => table.entries.length), 3);
  const path = join(root, 'registry', 'device-registry.dpapi');
  await writeFile(path, 'corrupt');
  await assert.rejects(launch('damaged', 'sample-D'), /注册表/);
  assert.equal(await readFile(path, 'utf8'), 'corrupt');
  await unlink(path);
  await assert.rejects(launch('missing', 'sample-E'), /注册表缺失/);
});

test('stable reuse across profiles and deletion, sticky usage, stale edits and confirmed versioned recovery', async () => {
  const registry = new MemoryDeviceRegistry();
  const first = new Engine(new Store(null), offline, registry), second = new Engine(new Store(null), offline, registry);
  const a = await first.addAccount('A', 'sample-A', school);
  const b = await second.addAccount('A', 'sample-A', school);
  assert.deepEqual(a.device, b.device);
  const initial = await second.inspectDevice(b.id);
  await first.configure(a.id, { device: { ...a.device, androidId: randomBytes(8).toString('hex').toUpperCase() } });
  await assert.rejects(second.configure(b.id, { device: b.device }), /冲突/);
  await assert.rejects(second.acceptRegisteredDevice(b.id, initial.revision!), /冲突/);
  await second.acceptRegisteredDevice(b.id, (await second.inspectDevice(b.id)).revision!);
  assert.deepEqual(a.device, b.device);
  a.session = demoSession(a);
  await first.clearSession(a.id);
  await first.deleteAccount(a.id);
  const again = await first.addAccount('Again', 'sample-A', school);
  assert.deepEqual(again.device, b.device);
  assert.equal(again.deviceUsage, 'attempted');
  assert.equal(JSON.stringify(appState(first.store.state)).includes(again.device.androidId), false);
  assert.equal((await first.inspectDevice(again.id)).device.androidId, again.device.androidId);
});

test('backfill preserves legacy and competing evidence; a conflict blocks both profiles', async () => {
  const registry = new MemoryDeviceRegistry();
  const stores = [new Store(null), new Store(null)];
  for (const store of stores) {
    const a = newAccount('A', 'sample-A', school.id);
    a.school = school;
    store.state.accounts.push(a);
  }
  const [a, b] = stores.map(s => s.state.accounts[0]!);
  a!.device.androidId = LEGACY_ANDROID_ID;
  const engines = stores.map(s => new Engine(s, offline, registry));
  await engines[0]!.initialize();
  assert.equal(a!.device.androidId, LEGACY_ANDROID_ID);
  const before = b!.device.androidId;
  await engines[1]!.initialize();
  assert.equal(b!.device.androidId, before);
  assert.equal((await engines[0]!.inspectDevice(a!.id)).conflict, true);
  assert.equal((await engines[1]!.inspectDevice(b!.id)).conflict, true);
  assert.equal(a!.deviceUsage, 'unknown');
});

test('portable merge checks registry usage, preserves scope, rejects stale sessions and evicts old clients', async t => {
  const root = await temp(t);
  const source = new Engine(new Store(null), offline), target = new Engine(new Store(null), offline);
  const a = await source.addAccount('Source', 'sample-A', school), b = await target.addAccount('Target', 'sample-A', school);
  const lib = { id: a.id, scope: 'public' as const, label: 'Library', schoolBaseUrl: school.baseUrl, schoolName: school.name,
    importedAt: 1, routeIds: [], runCount: 0 };
  source.store.state.libraries.push(lib);
  await source.store.putLibrary(lib.id, { runs: [], sensors: {} });
  const client = target.client(b);
  const path = join(root, 'portable.cgsbak'), pass = 'synthetic-passphrase';
  await source.exportBackup(path, pass, false);
  assert.equal((await target.importBackup(path, pass)).accountsUpdated, 1);
  const imported = target.account(b.id);
  assert.deepEqual(imported.device, a.device);
  assert.equal(imported.session, undefined);
  assert.notEqual(target.client(imported), client);
  assert.deepEqual(target.store.state.libraries[0], lib);
  for (const invalid of [true, false]) {
    a.session = demoSession(a);
    if (invalid) a.session.status = 'invalid'; else a.session.identity = 'mismatched';
    await source.exportBackup(path, pass, true);
    await target.importBackup(path, pass);
    assert.equal(target.account(b.id).session, undefined);
  }
  await source.configure(a.id, { device: { ...a.device, androidId: randomBytes(8).toString('hex') } });
  await source.exportBackup(path, pass, false);
  assert.deepEqual((await target.importBackup(path, pass)).conflicts, [a.id]);
  assert.notDeepEqual(target.account(b.id).device, a.device);
});

test('redo a staged manual change after a registry write failure; authentication stays closed until recovery', async t => {
  const root = await temp(t), vaultRoot = join(root, 'profile'), registryRoot = join(root, 'registry');
  let fail = false;
  const registry = new FileDeviceRegistry(registryRoot, { ...clearVault, protect: async b => {
    if (fail) throw Error('interrupted'); return b;
  } });
  const store = new Store(vaultRoot, clearVault);
  await store.open();
  const e = new Engine(store, offline, registry);
  const a = await e.addAccount('A', 'sample-A', school), desired = { ...a.device, androidId: randomBytes(8).toString('hex') };
  fail = true;
  await assert.rejects(e.configure(a.id, { device: desired }), /interrupted/);
  await assert.rejects(e.assertSession(a.id), /待恢复/);
  store.close();
  const reopened = new Store(vaultRoot, clearVault);
  await reopened.open();
  try {
    fail = false;
    const after = new Engine(reopened, offline, registry);
    await after.initialize();
    assert.deepEqual(after.account(a.id).device, desired);
    assert.equal((await after.inspectDevice(a.id)).conflict, false);
    assert.equal(reopened.state.pendingBindings, undefined);
  } finally { reopened.close(); }
});

test('legacy identity migration uses original field order, preserves casing and ignores unrelated digests', () => {
  const a = newAccount('A', 'sample-A', school.id);
  a.school = school;
  a.device.androidId = randomBytes(8).toString('hex').toUpperCase();
  a.device = Object.fromEntries(Object.entries(a.device).reverse()) as typeof a.device;
  const imei = deviceHeaders(a.device).imei;
  const { id, provinceCode, randomCode, baseUrl } = a.school;
  const legacy = createHash('sha256').update(JSON.stringify({ username: a.username, school: { id, provinceCode, randomCode, baseUrl },
    device: a.device, proxy: a.proxy })).digest('hex');
  a.session = { ...demoSession(a), identity: legacy };
  a.recordCache = { identity: legacy, sessionId: a.session.id, records: [], fetchedAt: 0 };
  migrateIdentity(a);
  assert.equal(a.session.identity, identity(a));
  assert.equal(a.recordCache.identity, identity(a));
  assert.equal(deviceHeaders(a.device).imei, imei);
  a.session.identity = 'unrelated'; migrateIdentity(a); assert.equal(a.session.identity, 'unrelated');
});

test('failed password attempt survives fresh profiles; public version checks do not register synthetic accounts', async () => {
  const registry = new MemoryDeviceRegistry(), requests: string[] = [];
  const first = new Engine(new Store(null), async url => {
    const path = new URL(String(url)).pathname; requests.push(path);
    if (path.endsWith('/version')) return Response.json({ code: 200, data: 'latest' });
    return Response.json({ code: 403 });
  }, registry);
  await first.configureSchool(school); await first.checkSchool();
  assert.equal(await registry.transaction(table => table.entries.length), 0);
  const a = await first.addAccount('A', 'sample-A', school);
  await assert.rejects(first.login(a.id, 'synthetic-password'));
  assert.ok(requests.some(p => p.endsWith('/login'))); assert.ok(a.lastLoginAt);
  assert.equal(a.session, undefined); assert.equal(a.deviceUsage, 'attempted');
  const other = new Engine(new Store(null), offline, registry);
  const restored = await other.addAccount('A', 'sample-A', school);
  assert.equal(restored.deviceUsage, 'attempted'); assert.equal(restored.lastLoginAt, undefined);
});

test('privacy mode never pre-fills the raw identifier or prints either IMEI during a manual edit', async () => {
  const e = new Engine(new Store(null), offline);
  const a = await e.addAccount('Example', 'sample-A', school);
  e.store.state.settings.privacyMode = true;
  const ui = new UIController(new LocalAppClient(e));
  const old = a.device.androidId, oldImei = deviceHeaders(a.device).imei;
  const next = randomBytes(8).toString('hex'), prompts: string[] = [];
  let form = 0;
  ui.ask = async (_title, label, value = '', secret = false) => {
    prompts.push(label, value);
    if (form++ === 0) return 'edit';
    if (form === 2) { assert.equal(secret, true); assert.equal(value, ''); return next; }
    return value;
  };
  ui.confirm = async (_title, label) => { prompts.push(label); };
  try {
    await ui.accounts.configure(ui.app.state.accounts[0]!);
    assert.equal(a.device.androidId, next);
    assert.match(prompts.join(' '), /绑定名额/);
    for (const value of [old, oldImei, next, deviceHeaders(a.device).imei]) assert.ok(!prompts.join(' ').includes(value));
  } finally { await ui.close(); }
});

test('school switches preserve the old registry key and prevent cross-tenant credential and private library reuse', async () => {
  const registry = new MemoryDeviceRegistry(), first = new Engine(new Store(null), offline, registry);
  const other = new Engine(new Store(null), offline, registry);
  const destination = { ...school, id: 'second', baseUrl: 'https://second.invalid/api/' };
  const a = await first.addAccount('A', 'sample-A', school);
  const prior = structuredClone(a.device); a.session = demoSession(a);
  const b = await other.addAccount('B', 'sample-A', destination);
  await assert.rejects(other.addAccount('Duplicate', 'sample-A', { ...destination, id: 'different' }), /账号已存在/);
  first.store.state.libraries.push({ id: 'local-records', scope: 'private', ownerAccountId: a.id,
    label: 'Old records', runCount: 0, routeIds: [], importedAt: 0 });
  await first.configureSchool(destination);
  assert.equal(a.school.id, school.id);
  await first.configure(a.id, { school: destination });
  assert.equal(a.session.status, 'invalid'); assert.deepEqual(a.device, b.device);
  await assert.rejects(first.prepareDefault(a.id), /记录库/);
  const readded = await first.addAccount('A', 'sample-A', school);
  assert.deepEqual(readded.device, prior);
  await assert.rejects(first.configure(readded.id, { school: destination }), /存在相同账号/);
});

test('interactive demo and headless demo never create the user registry', { skip: process.platform !== 'win32' }, async t => {
  const root = await temp(t), profile = join(root, 'worker'), previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    assert.ok(registryForWorker(true) instanceof MemoryDeviceRegistry);
    await exec(process.execPath, ['--import', 'tsx', resolve('src/cli.ts'), '--demo', '--preview'], { timeout: 30_000 });
    const worker = await runWorker(profile, true, false);
    try { await worker.engine.addAccount('Synthetic', 'sample-test', school); }
    finally { await worker.close(); }
    assert.equal((await readdir(root)).includes('CGSPORT'), false);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
  }
});

test('Windows registry persists DPAPI ciphertext and reopens independently of the profile vault', { skip: process.platform !== 'win32' }, async t => {
  const root = await temp(t);
  const e = new Engine(new Store(null), offline, new FileDeviceRegistry(root));
  const a = await e.addAccount('Synthetic', 'only-in-encrypted-registry', school);
  const ciphertext = await readFile(join(root, 'device-registry.dpapi'));
  assert.equal(ciphertext.includes(Buffer.from(a.username)), false);
  assert.equal(ciphertext.includes(Buffer.from(a.device.androidId)), false);
  const reopened = new Engine(new Store(null), offline, new FileDeviceRegistry(root));
  const restored = await reopened.addAccount('Reopened', a.username, school);
  assert.deepEqual(restored.device, a.device);
});

function makeSyntheticJwt(claims: Record<string, unknown>): string {
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const pld = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${hdr}.${pld}.synthetic_sig`;
}

test('umeng_it.cache Thrift Compact/Binary parsing, staged phone profile claim, and confirmed session adoption', async () => {
  const aidCompact = 'a1b2c3d4e5f60718';
  const aidBinary = '1122334455667788';
  const compactBuf = Buffer.concat([
    Buffer.from([0x15, 0x02, 0x0a]),
    Buffer.from('android_id', 'ascii'),
    Buffer.from([0x18, 0x10]),
    Buffer.from(aidCompact, 'ascii'),
    Buffer.from([0x16, 0x01, 0x00]),
  ]);
  assert.equal(parseUmengItCache(compactBuf), aidCompact);

  const binaryBuf = Buffer.alloc(4 + 10 + 1 + 2 + 4 + 16 + 4);
  binaryBuf.writeUInt32BE(10, 0);
  Buffer.from('android_id', 'ascii').copy(binaryBuf, 4);
  binaryBuf[14] = 0x0b;
  binaryBuf.writeUInt16BE(1, 15);
  binaryBuf.writeUInt32BE(16, 17);
  Buffer.from(aidBinary, 'ascii').copy(binaryBuf, 21);
  assert.equal(parseUmengItCache(binaryBuf), aidBinary);

  // Ambiguous cache with two different android_id values is rejected
  assert.equal(parseUmengItCache(Buffer.concat([compactBuf, binaryBuf])), undefined);
  // All-zero android_id is rejected
  const zeroBuf = Buffer.concat([Buffer.from([0x0a]), Buffer.from('android_id', 'ascii'), Buffer.from([0x18, 0x10]), Buffer.from('0000000000000000', 'ascii')]);
  assert.equal(parseUmengItCache(zeroBuf), undefined);

  // SnapshotCollector groups same-root XML + umeng_it.cache + HEADER.xml session
  const futureMs = String(Date.now() + 7 * 86_400_000);
  const jwt = makeSyntheticJwt({ sub: 'sample-phone-user', school_id: school.id, exp: Math.floor(Date.now() / 1000) + 86400 });
  const secret = Buffer.alloc(36, 9).toString('base64');
  const collector = new SnapshotCollector();
  collector.add('apps/net.crigh.cgsport/db/ygty_mysport.db', 16, () => Buffer.from('SQLite format 3\0', 'ascii'));
  const userXml = `<map><string name="USERXH">sample-phone-user</string><string name="USERNAME">Sample</string><string name="USER_SEX">1</string></map>`;
  const schoolXml = `<map><string name="SERVERURL">${school.baseUrl}</string><string name="SCHOOL_ID">${school.id}</string></map>`;
  const cfgXml = `<map><string name="uabc">{&quot;model&quot;:&quot;2407FRK8EC&quot;}</string></map>`;
  const hdrXml = `<map><string name="TOKEN">${jwt}</string><string name="SECRET">${secret}</string><string name="LOGIN_OUT_TIME">${futureMs}</string></map>`;
  collector.add('apps/net.crigh.cgsport/sp/USERINFO.xml', Buffer.byteLength(userXml), () => Buffer.from(userXml));
  collector.add('apps/net.crigh.cgsport/sp/SCHOOL.xml', Buffer.byteLength(schoolXml), () => Buffer.from(schoolXml));
  collector.add('apps/net.crigh.cgsport/sp/umzid_general_config.xml', Buffer.byteLength(cfgXml), () => Buffer.from(cfgXml));
  collector.add('apps/net.crigh.cgsport/sp/HEADER.xml', Buffer.byteLength(hdrXml), () => Buffer.from(hdrXml));
  collector.add('apps/net.crigh.cgsport/f/umeng_it.cache', compactBuf.length, () => compactBuf);
  const snap = collector.finish();
  assert.equal(snap.hints?.androidId, aidCompact);
  assert.equal(snap.hints?.model, '2407FRK8EC');
  assert.equal(snap.hints?.session?.token, jwt);

  // Import-before-addAccount: stagePhoneCandidate -> addAccount claims exact phone device without mutating unrelated accounts
  const registry = new MemoryDeviceRegistry();
  const engine = new Engine(new Store(null), async url => {
    const p = new URL(String(url)).pathname;
    if (p.endsWith('/version')) return Response.json({ code: 200, data: 'ok' });
    if (p.endsWith('/sporttype') || p.endsWith('/invalidconf')) return Response.json({ code: 200, data: [] });
    if (p.endsWith('/getConfig')) return Response.json({ code: 200, data: [] });
    return Response.json({ code: 404 });
  }, registry);
  const other = await engine.addAccount('Other', 'other-student', school);
  const otherDevice = structuredClone(other.device);

  engine.store.state.libraries.push({
    id: 'lib-phone-1', label: 'Backup', scope: 'public', schoolBaseUrl: school.baseUrl,
    runCount: 1, routeIds: ['27'], importedAt: Date.now(),
  });
  (engine as unknown as { recordPhoneHints: (id: string, h: unknown) => void }).recordPhoneHints('lib-phone-1', snap.hints);

  engine.store.state.settings.privacyMode = true;
  const summary = await engine.inspectPhoneCandidate('lib-phone-1');
  assert.ok(summary?.hasDevice && summary.hasSession);
  assert.equal(summary.displayAndroidId.includes(aidCompact), false);
  assert.equal(summary.matchedAccountId, undefined);
  await engine.stagePhoneCandidate('lib-phone-1');
  assert.deepEqual(other.device, otherDevice);

  const claimed = await engine.addAccount('Owner', 'sample-phone-user', school);
  assert.equal(claimed.device.androidId, aidCompact);
  assert.equal(claimed.device.model, '2407FRK8EC');
  assert.equal(claimed.deviceSource, 'phone');

  // Re-importing with session onto the matched account restores session only upon explicit adoptPhoneCandidate
  engine.store.state.libraries.push({
    id: 'lib-phone-2', label: 'Backup2', scope: 'private', ownerAccountId: claimed.id,
    schoolBaseUrl: school.baseUrl, runCount: 1, routeIds: ['27'], importedAt: Date.now(),
  });
  (engine as unknown as { recordPhoneHints: (id: string, h: unknown) => void }).recordPhoneHints('lib-phone-2', snap.hints);
  assert.equal(claimed.session, undefined);
  const adoptRes = await engine.adoptPhoneCandidate(claimed.id, 'lib-phone-2', true);
  assert.equal(adoptRes.sessionRestored, true);
  assert.equal(engine.account(claimed.id).session?.token, jwt);
  assert.equal(engine.account(claimed.id).deviceUsage, 'attempted');
});

test('5-part CAS token login enforces JWT claims and server u/info subject verification', async () => {
  const registry = new MemoryDeviceRegistry();
  const secret = Buffer.alloc(36, 5).toString('base64');
  const expSec = Math.floor(Date.now() / 1000) + 7200;
  const outMs = String(Date.now() + 7200_000);
  let serverXh = 'cas-user-1';
  const engine = new Engine(new Store(null), async url => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/version')) return Response.json({ code: 200, data: '当前已是最新版本' });
    if (u.pathname.endsWith('/u/info')) return Response.json({ code: 200, data: { xh: serverXh, xm: 'Synthetic', xb: '2' } });
    return Response.json({ code: 200, data: [] });
  }, registry);

  const acc = await engine.addAccount('CAS', 'cas-user-1', { ...school, loginType: '3' });
  // Wrong student ID in JWT -> rejected before network
  const wrongUserJwt = makeSyntheticJwt({ sub: 'someone-else', school_id: school.id, exp: expSec });
  await assert.rejects(engine.login(acc.id, `${wrongUserJwt}.${secret}.${outMs}`), /学号与当前账号不一致/);
  assert.equal(acc.session, undefined);

  // Wrong school_id in JWT -> rejected before network
  const wrongSchoolJwt = makeSyntheticJwt({ sub: 'cas-user-1', school_id: 'other-school', exp: expSec });
  await assert.rejects(engine.login(acc.id, `${wrongSchoolJwt}.${secret}.${outMs}`), /学校与当前账号不一致/);

  // Server u/info returns mismatched xh -> rejected
  const validJwt = makeSyntheticJwt({ sub: 'cas-user-1', school_id: school.id, exp: expSec });
  serverXh = 'mismatch-on-server';
  await assert.rejects(engine.login(acc.id, `${validJwt}.${secret}.${outMs}`), /无法验证/);
  assert.equal(acc.session, undefined);

  // Both JWT and server u/info confirm ownership -> session verified
  serverXh = 'cas-user-1';
  await engine.login(acc.id, `${validJwt}.${secret}.${outMs}`);
  const verifiedAcc = engine.account(acc.id);
  assert.equal(verifiedAcc.session?.status, 'verified');
  assert.equal(verifiedAcc.session?.xh, 'cas-user-1');
  assert.equal(verifiedAcc.session?.gender, '2');
});
