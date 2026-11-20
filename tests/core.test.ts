import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ProxyAgent } from 'undici';
import { Store, WindowsVault, type Vault } from '../src/runtime/storage.js';
import { Engine } from '../src/runtime/engine.js';
import { canUse, importLibrary } from '../src/track/library.js';
import { parseVersion } from '../src/protocol/index.js';
import { BASE, defaultDevice, deviceHeaders, identity, newAccount, type Library } from '../src/core/model.js';
import { demoFetch, demoRun, demoSecret, demoSession, seedDemo } from '../src/core/demo.js';
import { frame, stripAnsi, cells } from '../src/render/theme.js';
import { Transport, validateProxy } from '../src/runtime/transport.js';

// 测试用 AES vault：只注入测试，不作为真实模式的明文/跨平台后备。
class TestVault implements Vault {
  key = randomBytes(32);
  async protect(data: Buffer) { const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv); return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]); }
  async unprotect(data: Buffer) { const c = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12)); c.setAuthTag(data.subarray(-16)); return Buffer.concat([c.update(data.subarray(12, -16)), c.final()]); }
}

test('加密落盘、单进程锁、重开恢复；不在明文文件中留下会话', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cgsport-test-')), vault = new TestVault();
  const s = new Store(dir, vault); await s.open();
  try {
    const a = newAccount('测试', 'placeholder0001', 'test-school'); a.session = demoSession(a); s.state.accounts.push(a);
    await assert.rejects(new Store(dir, vault).open(), /另一个进程/);
    await s.save(); assert.equal((await readFile(join(dir, 'state.dpapi'))).includes(Buffer.from(a.session.token)), false);
    s.close();
    const next = new Store(dir, vault); await next.open();
    assert.equal(next.state.accounts[0]?.session?.token, a.session.token); next.close();
  } finally { s.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Windows DPAPI 使用真实系统 API 往返，无明文后备', { skip: process.platform !== 'win32' }, async () => {
  const vault = new WindowsVault(), text = Buffer.from('fake-session / 虚构凭据');
  const encrypted = await vault.protect(text);
  assert.equal(encrypted.includes(text), false); assert.deepEqual(await vault.unprotect(encrypted), text);
  encrypted[encrypted.length - 1] = encrypted[encrypted.length - 1]! ^ 1;
  await assert.rejects(vault.unprotect(encrypted));
});

test('private 不串账号，public 只按显式范围选择；无同路线绝不回退', async () => {
  const s = new Store(null); await seedDemo(s); const e = new Engine(s, demoFetch);
  const [a, b] = s.state.accounts, [privateLib, publicLib] = s.state.libraries;
  assert.ok(a && b && privateLib && publicLib);
  assert.ok(canUse(privateLib, a)); assert.equal(canUse(privateLib, b), false);
  await assert.rejects(e.prepare(b.id, privateLib.id), /不能使用/);
  await e.configure(b.id, { sourceMode: 'public' }); assert.ok(canUse(publicLib, b));
  const p = await e.prepare(b.id, publicLib.id); assert.equal(p.body.xh, b.username); assert.equal(p.routeId, b.routeId);
  await e.configure(b.id, { routeId: '999' }); await assert.rejects(e.prepare(b.id, publicLib.id), /同路线/);
});

test('导入复制到加密库；private 必须指定所有者', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cgsport-import-')), s = new Store(null), e = new Engine(s, demoFetch);
  try {
    const a = await e.addAccount('fake', 'placeholder1', 'school'); const file = join(dir, 'dataset.json');
    await writeFile(file, JSON.stringify({ coordinateSystem: 'GCJ-02', runs: [demoRun()] }));
    await assert.rejects(importLibrary(s, file, 'private', 'private'), /所属账号/);
    const l = await importLibrary(s, file, 'private', 'private', a.id);
    assert.equal(l.ownerAccountId, a.id); assert.equal(l.runCount, 1);
    await rm(file); assert.ok((await e.prepare(a.id, l.id)).sensor.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('版本检查 fail closed；更新/未知结构不变成已适配', () => {
  assert.equal(parseVersion('当前已是最新版本').status, 'ok');
  assert.equal(parseVersion('not the latest version').status, 'unknown');
  assert.equal(parseVersion('不是最新').status, 'unknown');
  assert.equal(parseVersion('发现新版本').status, 'unknown');
  assert.equal(parseVersion({ isForceUpdate: 1, content: 'upgrade' }).status, 'update');
  assert.equal(parseVersion({ isForceUpdate: 0, content: 'upgrade' }).status, 'update');
  assert.equal(parseVersion({ surprise: 'latest' }).status, 'unknown');
});

test('启动和切换没有登录；显式登录统一设备并限制重复请求', async () => {
  const s = new Store(null), calls: Array<{ path: string; headers: Headers }> = [];
  const fake: typeof fetch = async (url, init) => { calls.push({ path: new URL(String(url)).pathname, headers: new Headers(init?.headers) }); return demoFetch(url, init); };
  const e = new Engine(s, fake), a = await e.addAccount('a', 'placeholder1', 'school');
  await e.initialize(); e.account(a.id); assert.equal(calls.length, 0);
  await e.configure(a.id, { device: { ...defaultDevice(), androidId: '1234567890abcdef' } });
  await e.login(a.id, ' fake password ');
  const loginCall = calls.find(c => c.path.endsWith('/login'))!;
  assert.equal(loginCall.headers.get('imei'), deviceHeaders(a.device).imei);
  const versionCall = calls.find(c => c.path.endsWith('/version'))!;
  assert.equal(versionCall.headers.get('cgAuthorization'), null);
  assert.equal(versionCall.headers.get('imei'), null);
  await assert.rejects(e.login(a.id, 'fake'), /60 秒/);
  assert.equal(calls.filter(c => c.path.endsWith('/login')).length, 1);
});

test('发现更新只查询版本，绝不发送密码登录或任务开始', async () => {
  const s = new Store(null), paths: string[] = [];
  const e = new Engine(s, async url => { paths.push(new URL(String(url)).pathname); return Response.json({ code: 200, data: { isForceUpdate: 1, content: 'upgrade' } }); });
  const a = await e.addAccount('a', 'placeholder1', 'school');
  await assert.rejects(e.login(a.id, 'fake'), /更新/);
  assert.deepEqual(paths, ['/cgapp/api/version']); assert.equal(a.session, undefined);
});

test('更换元数据学校 ID 不能复制同一服务账号绕过任务隔离', async () => {
  const e = new Engine(new Store(null), demoFetch);
  await e.addAccount('first', 'placeholder1', 'school');
  await assert.rejects(e.addAccount('duplicate', 'placeholder1', 'different-school-id'), /账号已存在/);
});

test('开始请求在途也不能双击创建第二个任务', async () => {
  const s = new Store(null); await seedDemo(s); const a = s.state.accounts[0]!;
  let release!: () => void, began!: () => void, starts = 0;
  const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { began = r; });
  const e = new Engine(s, async (url, init) => {
    if (String(url).includes('/inSportTime')) { starts++; began(); await gate; }
    return demoFetch(url, init);
  });
  const p = await e.prepare(a.id, s.state.libraries[0]!.id), first = e.start(a.id, p);
  await entered; await assert.rejects(e.start(a.id, p), /正在处理其他操作/);
  release(); await first; assert.equal(starts, 1); assert.equal(s.state.tasks.length, 1);
});

test('只在 2003 单次续期且不密码重登；2001 标记失效', async () => {
  const s = new Store(null); await seedDemo(s); const a = s.state.accounts[0]!;
  const paths: string[] = []; let expired = true, revoked = false;
  const e = new Engine(s, async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.endsWith('/sportlist') && (expired || revoked)) { const code = revoked ? 2001 : 2003; expired = false; return Response.json({ code, message: 'fake' }); }
    return demoFetch(url, init);
  });
  const generation = a.session!.id;
  assert.equal((await e.records(a.id)).length, 1);
  assert.equal(paths.filter(p => p.endsWith('/issue')).length, 1); assert.equal(paths.filter(p => p.endsWith('/login')).length, 0);
  assert.equal(a.session!.id, generation); revoked = true;
  await assert.rejects(e.records(a.id), /2001/); assert.equal(a.session!.status, 'invalid');
  assert.equal(paths.filter(p => p.endsWith('/issue')).length, 1);
});

test('多账号任务贯穿原 One-Shot 五阶段；切换当前账号不改变归属', async () => {
  const s = new Store(null); await seedDemo(s); const [a, b] = s.state.accounts as [AccountForTest, AccountForTest];
  a.session!.token = 'accountA.payload.signature'; b.session!.token = 'accountB.payload.signature';
  const calls: Array<{ path: string; token: string | null; xh?: string }> = [];
  const e = new Engine(s, async (url, init) => {
    const path = new URL(String(url)).pathname, token = new Headers(init?.headers).get('cgAuthorization');
    let xh: string | undefined;
    if (path.endsWith('/savesports')) {
      const cipher = new URLSearchParams(String(init?.body)).get('jsonsports')!;
      const d = createDecipheriv('aes-128-ecb', Buffer.from(demoSecret.slice(0, 16)), '');
      xh = JSON.parse(Buffer.concat([d.update(Buffer.from(cipher, 'base64')), d.final()]).toString()).xh;
    }
    calls.push({ path, token, xh }); return demoFetch(url, init);
  });
  b.sourceMode = 'public';
  const pA = await e.prepare(a.id, s.state.libraries[0]!.id), pB = await e.prepare(b.id, s.state.libraries[1]!.id);
  const tA = await e.start(a.id, pA), tB = await e.start(b.id, pB);
  assert.equal(tA.phase, 'waiting'); assert.equal(tB.phase, 'waiting');
  await assert.rejects(e.start(a.id, pA), /一个未处理任务/);
  await assert.rejects(e.configure(a.id, { proxy: 'http://localhost:7890' }), /未处理任务/);
  e.account(b.id); // 界面选择不会成为执行器的隐式输入。
  for (const t of [tA, tB]) { t.session!.startAtMs = Date.now() - t.prepared.durationSec * 1000 - 10_000;
    t.session!.endAtMs = Date.now() - 10_000; t.session!.commitAtLocalMs = Date.now() - 100; }
  await e.tick();
  assert.equal(tA.phase, 'done'); assert.equal(tB.phase, 'done');
  assert.equal(tA.steps?.length, 5); assert.equal(tB.steps?.length, 5);
  assert.deepEqual(calls.filter(c => c.xh).map(c => [c.token, c.xh]).sort(),
    [[a.session!.token, a.username], [b.session!.token, b.username]].sort());
});
type AccountForTest = ReturnType<typeof newAccount>;

test('部分提交与超时保留任务；重启不会自动追发或重复开始', async () => {
  const s = new Store(null); await seedDemo(s); const a = s.state.accounts[0]!; let saves = 0;
  const e = new Engine(s, async (url, init) => { if (String(url).includes('/savesports')) { saves++; throw new Error('fake uncertain timeout'); } return demoFetch(url, init); });
  const p = await e.prepare(a.id, s.state.libraries[0]!.id), t = await e.start(a.id, p);
  t.session!.startAtMs = Date.now() - p.durationSec * 1000 - 1000; t.session!.endAtMs = Date.now() - 1000; t.session!.commitAtLocalMs = Date.now() - 100;
  await e.tick(); assert.equal(t.phase, 'review'); assert.equal(s.state.tasks.length, 1); assert.equal(saves, 1);
  await e.tick(); assert.equal(saves, 1); await assert.rejects(e.resume(t.id), /先核对结果/);
  t.phase = 'waiting'; const newEngine = new Engine(s, () => { throw new Error('must not request'); });
  await newEngine.initialize(); assert.equal(t.phase, 'paused'); await newEngine.tick(); assert.equal(saves, 1);
});

test('代理配置验证、重定向不跟随，失败不回落直连', async () => {
  assert.ok(validateProxy('socks5://localhost:7890')); assert.throws(() => validateProxy('file:///secret'));
  const calls: RequestInit[] = [], t = new Transport('', async (_url, init) => { calls.push(init!); throw new Error('failure with password'); });
  await assert.rejects(t.fetch(BASE + 'api/l/v7/sportlist'), /连接失败或超时/);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.redirect, 'error');
  await assert.rejects(t.fetch('https://attacker.invalid/'), /白名单/); assert.equal(calls.length, 1);
});

test('真实 ProxyAgent 经本地代理握手失败；测试禁止任何直接网络连接', async () => {
  let connects = 0, fetchCalls = 0;
  const server = createServer();
  server.on('connect', (_req, socket) => { connects++; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const t = new Transport(`http://127.0.0.1:${address.port}`), original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    // 在任何真实网络调用前强制检查：缺少本地代理 dispatcher 就抛错。
    assert.ok((init as RequestInit & { dispatcher?: unknown }).dispatcher instanceof ProxyAgent);
    return original(url, init);
  };
  try {
    await assert.rejects(t.fetch(BASE + 'api/l/v7/sportlist'), /连接失败/);
    assert.equal(fetchCalls, 1); assert.ok(connects >= 1);
  } finally {
    globalThis.fetch = original; await t.close(); await new Promise<void>(r => server.close(() => r()));
  }
});

test('终端显示学号，但不显示凭据/代理密码；不同宽度可渲染', async () => {
  const s = new Store(null); await seedDemo(s); const a = s.state.accounts[0]!;
  a.proxy = 'http://user:proxy-password@localhost:7890'; a.label = '\x1b[2Jinjected';
  for (const width of [42, 78, 110]) {
    const output = frame(s.state, { screen: 'home', selected: 0, notice: '' }, width, 32);
    const text = stripAnsi(output);
    for (const secret of [a.session!.token, a.session!.secret, 'proxy-password']) assert.equal(text.includes(secret), false);
    assert.ok(text.includes(a.username));
    assert.equal(output.includes('\x1b[2J'), false);
    assert.ok(text.includes('CGSCALINE') || text.includes('ACID TERMINAL'));
    assert.ok(text.split('\n').every(l => cells(l) < width));
  }
});

test('长账号列表滚动到选中项；确认表单不会显示密码', () => {
  const s = new Store(null);
  for (let i = 0; i < 30; i++) s.state.accounts.push(newAccount(`NEON-${i}`, `placeholder${i}`, 'school'));
  const text = stripAnsi(frame(s.state, { screen: 'home', selected: 28, notice: '' }, 90, 28));
  assert.ok(text.split('\n').some(l => l.includes('❯') && l.includes('NEON-28'))); assert.equal(text.split('\n').length, 28);
  const form = stripAnsi(frame(s.state, { screen: 'account', accountId: s.state.accounts[0]!.id, selected: 2, notice: '',
    form: { title: 'LOGIN', label: '密码', value: 'fake-password-with-spaces ', secret: true } }, 90, 28));
  assert.equal(form.includes('fake-password'), false); assert.ok(form.includes('••••'));
});
test('登录 HTTP 失败时，即使响应内业务码和凭据形似成功，也不保存会话',async()=>{
  const s=new Store(null);await seedDemo(s);const a=s.state.accounts[0]!;a.session=undefined;
  const e=new Engine(s,async(input,init)=>{
    const response=await demoFetch(input,init);
    return String(input).includes('/login')?new Response(await response.text(),{status:503,headers:{'Content-Type':'application/json'}}):response;
  });await e.initialize();await e.checkSchool();
  await assert.rejects(e.login(a.id,'fake-password'),/HTTP 503/);assert.equal(a.session,undefined);
});
test('记录查询 HTTP 失败不标为已验证，也不因响应内 2003 触发续期',async()=>{
  for(const code of[200,2003]){
    const s=new Store(null);await seedDemo(s);const a=s.state.accounts[0]!,paths:string[]=[];
    const e=new Engine(s,async(input,init)=>{const path=new URL(String(input)).pathname;paths.push(path);
      return path.endsWith('/sportlist')?Response.json({code,data:[]},{status:503}):demoFetch(input,init);});
    await e.initialize();await e.checkSchool();await assert.rejects(e.records(a.id),/HTTP 503/);
    assert.equal(a.session!.status,'saved');assert.equal(paths.some(p=>p.endsWith('/issue')||p.endsWith('/login')),false);
  }
});
