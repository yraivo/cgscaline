import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/runtime/storage.js';
import { allocateAndroidId, deviceConflicts, LEGACY_ANDROID_ID } from '../src/core/device-identity.js';
import { defaultDevice, deviceHeaders, identity, newAccount, phoneVersion } from '../src/core/model.js';
import { demoFetch, demoSession, seedDemo } from '../src/core/demo.js';
import { deviceFromPreset, deviceProfiles, devicePresetKeys } from '../src/core/device-profiles.js';

const COLLISION_A = '7217c949acb61b5f', COLLISION_B = 'b48c524b5385872d';

test('新账号均衡抽取完整设备预设和独立标识；重启不重新随机档案', async () => {
  const store = new Store(null), e = new Engine(store, demoFetch);
  for (let i = 0; i < 100; i++) await e.addAccount(`fake-${i}`, `placeholder${i}`, 'school');
  assert.equal(new Set(store.state.accounts.map(a => a.device.androidId)).size, 100);
  assert.equal(new Set(store.state.accounts.map(a => deviceHeaders(a.device).imei)).size, 100);
  assert.ok(store.state.accounts.every(a => a.device.androidId !== LEGACY_ANDROID_ID));
  assert.equal(new Set(store.state.accounts.map(a => a.device.model)).size, devicePresetKeys.length);
  const counts=devicePresetKeys.map(key=>store.state.accounts.filter(a=>a.device.model===deviceProfiles[key].model).length);
  assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
  for(const a of store.state.accounts){const preset=devicePresetKeys.find(key=>deviceProfiles[key].model===a.device.model)!;assert.deepEqual(a.device,deviceFromPreset(preset,a.device.androidId));}
  const snapshot = store.state.accounts.map(a => structuredClone(a.device));
  await e.initialize(); await e.initialize();
  assert.deepEqual(store.state.accounts.map(a => a.device), snapshot);
});

test('显式选择型号允许相同型号但标识独立；换预设只使本账号会话失效',async()=>{
  const store=new Store(null);let reads=0;const e=new Engine(store,async()=>{reads++;throw Error('unexpected');});
  const a=await e.addAccount('a','fake-a','21','pixel4'),b=await e.addAccount('b','fake-b','21','pixel4');
  assert.equal(a.device.model,b.device.model);assert.notEqual(deviceHeaders(a.device).imei,deviceHeaders(b.device).imei);
  a.session=demoSession(a);b.session=demoSession(b);const before=structuredClone(a),androidId=b.device.androidId;
  await e.configure(b.id,{device:deviceFromPreset('pixel5',androidId)});
  assert.equal(b.device.androidId,androidId);assert.equal(b.session.status,'invalid');assert.deepEqual(a,before);assert.equal(reads,0);
  await assert.rejects(e.configure(b.id,{device:{...b.device,model:'Pixel 5,30'}}),/格式错误/);
  await assert.rejects(e.configure(b.id,{device:{...b.device,model:'Pixel\r\n5'}}),/格式错误/);
  const count=store.state.accounts.length;await assert.rejects(e.addAccount('c','fake-c','21','unknown' as never),/无效/);assert.equal(store.state.accounts.length,count);
});

test('两个不同 Android ID 的真实哈希碰撞会被识别并重抽', () => {
  const a = newAccount('a', 'placeholder1', 'school'); a.device.androidId = COLLISION_A;
  assert.equal(deviceHeaders({ ...a.device, androidId: COLLISION_B }).imei, deviceHeaders(a.device).imei);
  const candidates = [COLLISION_A, COLLISION_B, '1234567890abcdef'];
  assert.equal(allocateAndroidId([a], () => candidates.shift()!), '1234567890abcdef');
  const b = newAccount('b', 'placeholder2', 'school'); b.device.androidId = COLLISION_B;
  assert.deepEqual(deviceConflicts(b, [a, b]).map(v => v.id), [a.id]);
});

test('手动配置拦截原 ID 与派生 imei 重复，失败不污染原档案或会话', async () => {
  const store = new Store(null), e = new Engine(store, demoFetch);
  const a = await e.addAccount('a', 'placeholder1', 'school'), b = await e.addAccount('b', 'placeholder2', 'school');
  await e.configure(a.id, { device: { ...a.device, androidId: COLLISION_A } });
  b.session = demoSession(b); const before = structuredClone(b);
  await assert.rejects(e.configure(b.id, { device: { ...b.device, androidId: COLLISION_A } }), /标识冲突/);
  assert.deepEqual(b, before);
  await assert.rejects(e.configure(b.id, { device: { ...b.device, androidId: COLLISION_B } }), /标识冲突/);
  assert.deepEqual(b, before);
  await assert.rejects(e.configure(b.id, { device: { ...b.device, androidId: '0000000000000000' } }), /格式错误/);
  assert.deepEqual(b, before);
  await e.configure(b.id, { device: { ...b.device, androidId: '1234567890ABCDEF' } });
  assert.equal(b.device.androidId, '1234567890abcdef'); assert.equal(b.session!.status, 'invalid');
});

test('旧空档案自动分配新 ID，保留已有会话绑定且零网络', async () => {
  const store = new Store(null), a = newAccount('old-session', 'placeholder1', 'school'), b = newAccount('old-empty', 'placeholder2', 'school');
  a.device.androidId = b.device.androidId = LEGACY_ANDROID_ID; a.session = demoSession(a);
  const token = a.session.token; store.state.accounts.push(a, b);
  const e = new Engine(store, async () => { throw new Error('must stay offline'); });
  await e.initialize(); assert.equal(a.device.androidId, LEGACY_ANDROID_ID); assert.equal(a.session.token, token);
  assert.notEqual(b.device.androidId, LEGACY_ANDROID_ID); assert.equal(deviceConflicts(a, store.state.accounts).length, 0);
  assert.ok(e.startupNotices.some(v => v.includes('old-empty')));
});

test('两个已有会话冲突时均禁止认证业务，标识和凭据不被静默改写；公共检查仍可用', async () => {
  const store = new Store(null); await seedDemo(store); const [a, b] = store.state.accounts;
  assert.ok(a && b); a.device.androidId = b.device.androidId = LEGACY_ANDROID_ID;
  a.session = demoSession(a); b.session = demoSession(b);
  const original = [a.session.token, b.session.token]; const paths: string[] = [];
  const e = new Engine(store, async (url, init) => { paths.push(new URL(String(url)).pathname); return demoFetch(url, init); });
  await e.initialize();
  assert.equal(a.device.androidId, LEGACY_ANDROID_ID); assert.equal(b.device.androidId, LEGACY_ANDROID_ID);
  assert.deepEqual([a.session.token, b.session.token], original);
  await assert.rejects(e.login(a.id, 'fake'), /标识冲突/); await assert.rejects(e.records(b.id), /标识冲突/);
  await assert.rejects(e.ensureCompatible(a.id), /标识冲突/); assert.equal(paths.length, 0);
  await e.checkSchool(); assert.deepEqual(paths, ['/cgapp/api/version']);
});

test('显式更换仅修改当前账号标识并使其旧会话需登录；不会连带修改其他账号', async () => {
  const store = new Store(null); await seedDemo(store); const [a, b] = store.state.accounts;
  assert.ok(a && b); a.device.androidId = b.device.androidId = LEGACY_ANDROID_ID;
  a.session = demoSession(a); b.session = demoSession(b); const originalA = structuredClone(a);
  const e = new Engine(store, async () => { throw new Error('must stay offline'); });
  await e.regenerateDevice(b.id);
  assert.deepEqual(a, originalA); assert.notEqual(b.device.androidId, a.device.androidId);
  assert.notEqual(deviceHeaders(b.device).imei, deviceHeaders(a.device).imei);
  assert.equal(b.session.status, 'invalid'); assert.equal(deviceConflicts(a, store.state.accounts).length, 0);
});

test('设备标识经实际 DPAPI 保存/重开后不改变，也不自动密码登录', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cgsport-device-')), store = new Store(dir);
  let next: Store | undefined;
  try {
    await store.open(); const e = new Engine(store, demoFetch);
    const a = await e.addAccount('fake', 'placeholder1', 'school'); const before = structuredClone(a.device);
    await e.shutdown(); next = new Store(dir); await next.open();
    await new Engine(next, async () => { throw new Error('must stay offline'); }).initialize();
    assert.deepEqual(next.state.accounts[0]!.device, before);
    assert.equal(next.state.accounts[0]!.session, undefined);
  } finally { store.close(); next?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('请求边界拒绝串用其他账号 token、错误 imei 和旧 client；全部零外发', async () => {
  const store = new Store(null); await seedDemo(store); const [a, b] = store.state.accounts;
  assert.ok(a && b); a.session!.token = 'fakeA.payload.signature'; b.session!.token = 'fakeB.payload.signature';
  let calls = 0; const e = new Engine(store, async () => { calls++; return Response.json({ code: 200 }); });
  const p = e.client(a), headers = { imei: deviceHeaders(a.device).imei, 'User-Agent': deviceHeaders(a.device).userAgent, cgAuthorization: a.session!.token };
  const url = `${a.school.baseUrl}api/l/v7/sportlist?xh=${a.username}`;
  await assert.rejects(p.fetch(url, { headers: { ...headers, cgAuthorization: b.session!.token } }), /登录信息.*不匹配/);
  await assert.rejects(p.fetch(url, { headers: { ...headers, imei: deviceHeaders(b.device).imei } }), /设备标识.*不匹配/);
  await assert.rejects(p.fetch('https://tyapp.chingo.cn/cgapp/api/version', { headers }), /更新检查的请求配置/);
  const originalXh = a.session!.xh; a.session!.xh = b.username;
  assert.throws(() => p.session(a), /登录信息已失效/);
  await assert.rejects(p.fetch(url, { headers }), /登录信息.*不匹配/); a.session!.xh = originalXh;
  a.device.androidId = allocateAndroidId(store.state.accounts);
  await assert.rejects(p.fetch(url, { headers }), /配置已变化/); assert.equal(calls, 0);
  await e.deleteAccount(a.id);
  await assert.rejects(p.fetch(url, { headers }), /账号不存在/); assert.equal(calls, 0);
});

test('两个账号从登录/查询/续期到五阶段任务都使用各自稳定身份', async () => {
  const store = new Store(null); await seedDemo(store); const [a, b] = store.state.accounts;
  assert.ok(a && b); b.sourceMode = 'public';
  b.device = { ...defaultDevice(), manufacturer: 'Google', model: 'Pixel', androidRelease: '12', sdk: '31', buildId: 'TEST_BUILD' }; b.session = demoSession(b);
  const secrets = new Map([[a.username, Buffer.alloc(52, 11).toString('base64')], [b.username, Buffer.alloc(52, 23).toString('base64')]]);
  const decrypt = (cipher: string, secret: string) => {
    const decoder = createDecipheriv('aes-128-ecb', Buffer.from(secret.slice(0,16)), '');
    return JSON.parse(Buffer.concat([decoder.update(Buffer.from(cipher,'base64')),decoder.final()]).toString());
  };
  const seen: Array<{ account: string; path: string; imei: string; ua: string }> = []; let expireA = true;
  const e = new Engine(store, async (url, init) => {
    const target = new URL(String(url)), path = target.pathname, h = new Headers(init?.headers);
    if (path.endsWith('/version')) { assert.equal(h.get('cgAuthorization'), null); assert.equal(h.get('imei'), null); return demoFetch(url, init); }
    const loginUser = path.endsWith('/login') ? new URLSearchParams(String(init?.body)).get('username') : null;
    const owner = loginUser ?? target.searchParams.get('xh') ?? h.get('cgAuthorization')!.split('.')[0]!.replace(/^renewed-/, '');
    const account = [a,b].find(v => v.username === owner)!; assert.ok(account);
    assert.equal(h.get('imei'), deviceHeaders(account.device).imei); assert.equal(h.get('User-Agent'), deviceHeaders(account.device).userAgent);
    seen.push({ account: owner, path, imei: h.get('imei')!, ua: h.get('User-Agent')! });
    const secret = secrets.get(owner)!;
    if (loginUser) return Response.json({ code: 200, data: { token: `${owner}.payload.signature.${secret}.1900000000000`, info: { xh: owner } } });
    assert.equal(decrypt(h.get('client')!, secret).root, '0');
    if (path.endsWith('/sportlist') && owner === a.username && expireA) { expireA = false; return Response.json({ code: 2003 }); }
    if (path.endsWith('/issue')) {
      const renewedSecret = Buffer.alloc(52, 31).toString('base64'); secrets.set(owner, renewedSecret);
      return Response.json({ code: 200, data: `renewed-${owner}.payload.signature.${renewedSecret}.1900000000000` });
    }
    if (path.endsWith('/savesports')) {
      const cipher = new URLSearchParams(String(init?.body)).get('jsonsports')!;
      const json = decrypt(cipher, secret);
      assert.equal(json.xh, account.username); assert.equal(json.phoneVersion, phoneVersion(account.device));
    }
    return demoFetch(url, init);
  });
  const originalIds = [a.device.androidId,b.device.androidId]; await e.initialize();
  await e.login(a.id,'fake'); await e.login(b.id,'fake'); await e.records(a.id); await e.records(b.id);
  const tA = await e.start(a.id,await e.prepareDefault(a.id)), tB = await e.start(b.id,await e.prepareDefault(b.id));
  await e.fastForwardDemo(tA.id); await e.fastForwardDemo(tB.id);
  assert.equal(tA.phase,'done'); assert.equal(tB.phase,'done'); assert.deepEqual([a.device.androidId,b.device.androidId],originalIds);
  assert.notEqual(deviceHeaders(a.device).imei,deviceHeaders(b.device).imei);
  for (const account of [a,b]) for (const suffix of ['/login','/sportlist','/inSportTime','/sportsId','/prejudgment','/savesports','/sensorZipFile'])
    assert.ok(seen.some(v=>v.account===account.username&&v.path.endsWith(suffix)), `${account.label} ${suffix}`);
  assert.equal(seen.filter(v=>v.path.endsWith('/issue')).length,1);
});

test('设备变更后旧预览失效；新准备的任务仍能使用当前设备', async () => {
  const store = new Store(null); await seedDemo(store); const a = store.state.accounts[0]!;
  const e = new Engine(store,demoFetch), old = await e.prepareDefault(a.id);
  await e.regenerateDevice(a.id); a.session = demoSession(a);
  await assert.rejects(e.start(a.id,old),/设备档案已过期/);
  const task = await e.start(a.id,await e.prepareDefault(a.id)); assert.equal(task.phase,'waiting');
  await assert.rejects(e.regenerateDevice(a.id),/未处理任务/);
  assert.equal(task.identity,identity(a));
});

test('计划准备期间更换设备或删除账号，不会保存过期计划或外发', async () => {
  for (const change of ['regenerate', 'delete']) {
    const store = new Store(null); await seedDemo(store); const a = store.state.accounts[0]!;
    const e = new Engine(store, async () => { throw new Error('must stay offline'); });
    const read = store.getLibrary.bind(store);
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    store.getLibrary = async <T>(id: string): Promise<T> => {
      const data = await read<T>(id); ready(); await released; return data;
    };
    const pending = e.queuePlan([a.id], Date.now() + 60_000, 0);
    await entered;
    if (change === 'regenerate') await e.regenerateDevice(a.id); else await e.deleteAccount(a.id);
    release(); await assert.rejects(pending, /账号配置已变化/);
    assert.equal(store.state.tasks.length, 0);
  }
});
