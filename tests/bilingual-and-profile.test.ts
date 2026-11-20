import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { DEFAULT_WCDB_KEY, decryptWcdbBuffer, parseSensorText } from '../src/campus/android-import.js';
import { LocalAppClient } from '../src/app/local-client.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { Engine } from '../src/runtime/engine.js';
import { cliLanguage, localizeBackendText } from '../src/core/i18n.js';
import type { WorkerAddress } from '../src/runtime/ipc.js';
import { searchSchools, normalizeSchoolServerUrl } from '../src/campus/school-directory.js';
import { loadSchoolProfile } from '../src/campus/school-profile.js';
import { Store, WindowsVault, type Vault } from '../src/runtime/storage.js';
import { frame, stripAnsi } from '../src/render/theme.js';
import { UIController } from '../src/ui/controller.js';
import { connectWorker, runWorker } from '../src/runtime/worker.js';

const require = createRequire(import.meta.url);

const passthroughVault: Vault = {
  async protect(d) { return d; },
  async unprotect(d) { return d; },
};

test('双语切换与英文界面渲染：主页按 L / 外观切换 / CLI 参数完整呈现英文界面且兼容隐私遮罩', async () => {
  assert.equal(cliLanguage(['--en']), 'en');
  assert.equal(cliLanguage(['--lang', 'en-US']), 'en');
  assert.equal(cliLanguage(['--lang=zh-CN']), 'zh');

  const store = new Store(null);
  await seedDemo(store, 'en');
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  await engine.checkSchool();
  const a = store.state.accounts[0]!;
  await engine.information(a.id, true);
  await engine.schoolInformation(a.id, true);
  await engine.schoolNotices(a.id, true);

  const client = new LocalAppClient(engine);
  const ui = new UIController(client, true, true, false);
  ui.start();

  const homeEn = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 132, 40, false, true));
  assert.match(homeEn, /CAMPUS TELEMETRY/);
  assert.match(homeEn, /UP TO DATE/);
  assert.match(homeEn, /ACCOUNTS/);
  assert.match(homeEn, /ACTIVE 0\/2/);
  assert.match(homeEn, /CURRENT TERM/);
  assert.match(homeEn, /CAMPUS BULLETIN/);
  assert.match(homeEn, /ACTIVITY STREAM/);
  assert.match(homeEn, /Q Quit/);

  const shot = await client.commands.prepareDefault(a.id);
  const oneshotEn = stripAnsi(frame(store.state, { screen: 'oneshot', accountId: a.id, preview: shot, selected: 0, notice: '' }, 118, 32, false, true));
  assert.match(oneshotEn, /Auto Corridor Fit/);
  assert.match(oneshotEn, /Synthesized IMU/);
  assert.match(oneshotEn, /Auto-commit in/);

  // 开启隐私模式验证英文遮罩文案
  ui.handle('x', { name: 'x', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  const maskedEn = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 132, 40, false, true));
  assert.match(maskedEn, /PRIVACY MASK/);
  assert.match(maskedEn, /X Unmask/);
  assert.equal(maskedEn.includes(a.username), false);

  // 主页按 L 切回中文，再按 L 切回英文
  ui.handle('l', { name: 'l', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(client.state.settings.language, 'zh');
  const homeZh = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 132, 40, false, true));
  assert.match(homeZh, /校区运动中心/);
  assert.match(homeZh, /Q 关闭/);

  ui.handle('l', { name: 'l', ctrl: false, meta: false });
  while (ui.view.busy) await new Promise(r => setTimeout(r, 5));
  assert.equal(client.state.settings.language, 'en');

  await ui.close();
  await client.close();
});

test('外部 school-profile.json 自动加载：零源码硬编码支持自定义校区域名、编码与电子围栏', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cgs-profile-test-'));
  try {
    await writeFile(
      join(root, 'school-profile.json'),
      JSON.stringify({
        name: '测试大学',
        nameEn: 'Test University',
        schoolId: '88',
        provinceCode: '31',
        randomCode: '19',
        baseUrl: 'https://campus-custom.chingo.cn/cgapp-server/',
        defaultRouteId: '12',
        routes: {
          '12': {
            name: '北区田径场',
            nameEn: 'North Track',
            boundaryGcj02: [
              [30.002, 103.002],
              [29.998, 103.002],
              [29.998, 102.998],
              [30.002, 102.998],
              [30.002, 103.002],
            ],
          },
        },
      }),
      'utf8',
    );
    const loaded = loadSchoolProfile(root);
    assert.equal(loaded.fromDisk, true);
    assert.equal(loaded.profile.nameEn, 'Test University');

    const store = new Store(root, passthroughVault);
    await store.open();
    const seenHosts: string[] = [];
    const engine = new Engine(store, async (input, init) => {
      seenHosts.push(new URL(String(input)).hostname);
      return demoFetch(input, init);
    });
    await engine.initialize();
    assert.equal(store.state.settings.schoolId, '88');
    assert.equal(store.state.settings.schoolName, '测试大学');
    assert.equal(store.state.settings.schoolNameEn, 'Test University');

    const acc = await engine.addAccount('CustomAcc', 'stu2026', '');
    assert.equal(acc.school.id, '88');
    assert.equal(acc.school.provinceCode, '31');
    assert.equal(acc.school.randomCode, '19');
    assert.equal(acc.school.baseUrl, 'https://campus-custom.chingo.cn/cgapp-server/');
    assert.equal(acc.routeId, '12');

    await engine.checkSchool();
    await engine.login(acc.id, 'demo-pass');
    assert.ok(seenHosts.includes('campus-custom.chingo.cn'));

    const enFrame = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 120, 34, false, true));
    assert.match(enFrame, /测试大学 · 88/);
    store.state.settings.language = 'en';
    const enFrame2 = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 120, 34, false, true));
    assert.match(enFrame2, /Test University · 88/);

    await engine.shutdown();
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('多级菜单 Esc 逐级返回并保留光标位置；全局设置实时显示状态且通知/并发/帧率 (20/30/60) 可直接切换', async () => {
  assert.equal(localizeBackendText('请间隔 30 秒再刷新学校通知。', 'en'), 'Notices cooldown: wait 30s before refreshing.');
  assert.equal(localizeBackendText('未发现更新', 'en'), 'Up to date');

  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  const client = new LocalAppClient(engine);
  const ui = new UIController(client, true, true, true);
  ui.start();

  const press = async (name: string, ch = '') => {
    ui.handle(ch, { name, ctrl: false, meta: false });
    while (ui.view.busy) await new Promise(r => setTimeout(r, 2));
  };

  // 1. 主页选第 2 个账号 -> 账号页 -> 账号设置 (index=3) -> Esc 回到账号页 (selected=3) -> Esc 回到主页 (selected=1)
  await press('down');
  assert.equal(ui.view.selected, 1);
  await press('return', '\r');
  assert.equal(ui.view.screen, 'account');
  for (let i = 0; i < 3; i++) await press('down');
  assert.equal(ui.view.selected, 3);
  await press('return', '\r');
  assert.equal(ui.view.screen, 'manage');
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'account');
  assert.equal(ui.view.selected, 3);
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'home');
  assert.equal(ui.view.selected, 1);

  // 2. 主页 -> 更多 (/) -> 全局设置 (index=7) -> 完成与异常通知 (index=4) 回车与左右切换
  await press('/', '/');
  assert.equal(ui.view.screen, 'menu');
  await press('up'); // 跳到末尾「全局设置」(index=7)
  assert.equal(ui.view.selected, 7);
  await press('return', '\r');
  assert.equal(ui.view.screen, 'settings');

  // 移动到「完成与异常通知」(index=4)，验证行内显示开启/关闭且底部给出明确反馈
  for (let i = 0; i < 4; i++) await press('down');
  assert.equal(ui.view.selected, 4);
  const beforeToggle = stripAnsi(frame(store.state, ui.view, 118, 34, false, true));
  assert.match(beforeToggle, /完成与异常通知\s+开启/);

  await press('return', '\r');
  assert.equal(store.state.settings.notifications, false);
  assert.match(ui.view.notice, /已关闭/);
  const afterOff = stripAnsi(frame(store.state, ui.view, 118, 34, false, true));
  assert.match(afterOff, /完成与异常通知\s+关闭/);

  await press('right');
  assert.equal(store.state.settings.notifications, true);
  assert.match(ui.view.notice, /已开启/);

  // 3. 从全局设置进入记录库 (index=2) -> 查看库详情 -> Esc 回记录库 -> Esc 回全局设置 (selected=2) -> 外观 -> 帧率 20->30->60
  await press('up');
  await press('up');
  assert.equal(ui.view.selected, 2);
  await press('return', '\r');
  assert.equal(ui.view.screen, 'libraries');
  await press('return', '\r');
  assert.equal(ui.view.screen, 'records');
  assert.equal(ui.view.title, '记录库详情');
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'libraries');
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'settings');
  assert.equal(ui.view.selected, 2);

  await press('down'); // 外观 (index=3)
  await press('return', '\r');
  assert.equal(ui.view.screen, 'appearance');
  for (let i = 0; i < 5; i++) await press('down'); // 动画帧率 (index=5)
  assert.equal(store.state.settings.animationFps, 20);
  await press('right');
  assert.equal(store.state.settings.animationFps, 30);
  await press('right');
  assert.equal(store.state.settings.animationFps, 60);
  await press('right');
  assert.equal(store.state.settings.animationFps, 20);

  // Esc 逐级返回：appearance -> settings (selected=3) -> menu (selected=7) -> home
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'settings');
  assert.equal(ui.view.selected, 3);
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'menu');
  assert.equal(ui.view.selected, 7);
  await press('escape', '\x1b');
  assert.equal(ui.view.screen, 'home');

  await ui.close();
  await client.close();
});

test('旧后台高 revision 热重启升级到新后台后，RemoteAppClient 不会因旧 revision 丢弃 X/L/FPS/通知状态更新',
  { skip: process.platform !== 'win32', timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cgs-hot-upgrade-'));
    let upgradedClient: Awaited<ReturnType<typeof connectWorker>> | undefined;
    try {
      // 1. 启动旧后台并将 revision 推高到 > 10，模拟已长期运行的旧版守护进程
      const oldWorker = await runWorker(root, true, false);
      for (let i = 0; i < 6; i++) {
        await oldWorker.engine.configureAppearance({ visualOpacity: i % 2 ? 50 : 35 });
      }
      const vault = new WindowsVault();
      const descPath = join(root, 'worker.dpapi');
      const addr = JSON.parse((await vault.unprotect(await readFile(descPath))).toString('utf8')) as WorkerAddress;
      addr.rev = 'legacy-worker-rev';
      await writeFile(descPath, await vault.protect(Buffer.from(JSON.stringify(addr))));

      // 2. connectWorker 检测到旧 rev 自动平滑重启新后台（新后台 revision 从 1 重新开始）
      upgradedClient = await connectWorker(root, {
        demo: true,
        start: true,
        entry: resolve('src/cli.ts'),
        notifications: false,
      });
      assert.equal(upgradedClient.notices.some(n => n.includes('后台已断开')), false);

      const ui = new UIController(upgradedClient, true, true, true);
      ui.start();
      const press = async (name: string, ch = '') => {
        ui.handle(ch, { name, ctrl: false, meta: false });
        while (ui.view.busy) await new Promise(r => setTimeout(r, 2));
      };

      // 3. 第一次按键就必须立即更新前端 client.state（绝不被旧后台的高 revision 屏蔽！）
      const initialPriv = !!upgradedClient.state.settings.privacyMode;
      await press('x', 'x');
      assert.equal(upgradedClient.state.settings.privacyMode, !initialPriv);

      await press('l', 'l');
      assert.equal(upgradedClient.state.settings.language, 'en');

      await upgradedClient.commands.configureAppearance({ animationFps: 60 });
      assert.equal(upgradedClient.state.settings.animationFps, 60);

      await upgradedClient.commands.configureSettings({ notifications: false });
      assert.equal(upgradedClient.state.settings.notifications, false);
      await upgradedClient.commands.configureSettings({ notifications: true });
      assert.equal(upgradedClient.state.settings.notifications, true);

      await ui.close();
      await upgradedClient.commands.stopBackground().catch(() => {});
    } finally {
      await upgradedClient?.close().catch(() => {});
      await new Promise(r => setTimeout(r, 200));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
  },
);

test('官方学校目录搜索与登录自动拉取 /sporttype 电子围栏（零外部配置文件即可接入任意高校）', async () => {
  const store = new Store(null);
  const engine = new Engine(store, demoFetch);
  await engine.initialize();
  assert.equal(store.state.settings.colorTheme, 'mescaline');

  // 默认 120x30 终端窗口直接显示 The Edge 立体字标
  const defaultWindow = stripAnsi(frame(store.state, { screen: 'home', selected: 0, notice: '' }, 120, 30, false, true));
  assert.match(defaultWindow, /▄█▄/);

  // 并发上限放宽至 1–16
  await engine.configureSettings({ maxConcurrent: 12 });
  assert.equal(store.state.settings.maxConcurrent, 12);
  await assert.rejects(engine.configureSettings({ maxConcurrent: 17 }), /设置无效/);

  // 兼容个别高校重复拼接 URL 与 XJTU 特判
  assert.equal(
    normalizeSchoolServerUrl('http://172.16.42.66/cgapp-server/http://172.16.42.66/cgapp-server/', 'ZTHC'),
    'http://172.16.42.66/cgapp-server/',
  );
  assert.equal(normalizeSchoolServerUrl('https://anything.example.com', 'XJTU'), 'http://ggtypt.xjtu.edu.cn/cgapp-server/');

  const schools = await engine.listSchools();
  assert.equal(schools.length, 2);
  assert.equal(searchSchools(schools, '演示')[0]?.id, '99');
  assert.equal(searchSchools(schools, '示例理工')[0]?.code, 'SIT');
  // 子序列模糊搜索（如输入简称「示理」匹配「示例理工学院」）
  assert.equal(searchSchools(schools, '示理')[0]?.id, '1');

  const picked = searchSchools(schools, 'SIT')[0]!;
  const acc = await engine.addAccount('新用户', 'u202601', picked);
  assert.equal(acc.school.id, '1');
  assert.equal(acc.school.name, '示例理工学院');
  assert.equal(store.state.settings.schoolName, '示例理工学院');

  // 登录后自动预拉取 /sporttype 并把 latlng 解析为 GCJ-02 多边形围栏
  await engine.login(acc.id, 'pass123');
  const rules = store.state.accounts[0]!.information?.rules.data;
  assert.ok(rules && rules.length >= 2);
  assert.equal(rules[0]!.boundaryGcj02?.length, 4);

  // 支持 CAS 统一身份认证高校直接粘贴 5 段回调 Token 建立会话
  const casAcc = await engine.addAccount('统一认证号', 'cas2026', { ...picked, id: '2', baseUrl: 'https://cgapp.chingo.cn/cgapp-server/', loginType: '3' });
  const fakeSecret = Buffer.alloc(52, 7).toString('base64');
  await engine.login(casAcc.id, `hdr.pld.sig.${fakeSecret}.1900000000000`);
  assert.equal(store.state.accounts[1]!.session?.token, 'hdr.pld.sig');
  assert.equal(store.state.accounts[1]!.session?.secret, fakeSecret);

  await engine.shutdown();
});

test('内置纯 Node WCDB 数据库解密与安卓 .bak 备份包直接导入（无需 Python 脚本）', async () => {
  assert.deepEqual(parseSensorText('[,9.73,9.81,9.65,9.77,9.80,9.72,9.79,9.84,9.69,9.75]'), [
    9.73, 9.81, 9.65, 9.77, 9.8, 9.72, 9.79, 9.84, 9.69, 9.75,
  ]);

  const work = await mkdtemp(join(tmpdir(), 'cgs-wcdb-test-'));
  try {
    const plainPath = join(work, 'plain.sqlite');
    // 初始化带 PageSize=1024 + ReserveSize=48 的合法空白 SQLite 页，使后续建表都在页尾预留 48 字节 IV 区
    const seedPage = Buffer.alloc(1024, 0);
    Buffer.from('SQLite format 3\0', 'ascii').copy(seedPage, 0);
    seedPage.writeUInt16BE(1024, 16);
    seedPage[18] = 1;
    seedPage[19] = 1;
    seedPage[20] = 48;
    seedPage[21] = 64;
    seedPage[22] = 32;
    seedPage[23] = 32;
    seedPage.writeUInt32BE(1, 28);
    seedPage.writeUInt32BE(4, 44);
    seedPage.writeUInt32BE(1, 56);
    seedPage.writeUInt32BE(3045000, 96);
    seedPage[100] = 0x0d;
    seedPage.writeUInt16BE(1024 - 48, 105);
    await writeFile(plainPath, seedPage);

    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void };
    };
    const db = new DatabaseSync(plainPath);
    db.exec(`
      CREATE TABLE sportbean (
        id INTEGER PRIMARY KEY, sportid TEXT, routeid TEXT, routename TEXT,
        startdate TEXT, enddate TEXT, startdatelong INTEGER,
        dllc REAL, dltime TEXT, totalstep INTEGER, avgspeed REAL, avgpace TEXT, stepminute REAL,
        status INTEGER, activitystatus INTEGER, result INTEGER, gyrouploadstatus INTEGER,
        checkstatus TEXT, checkresult TEXT, isvalidreason TEXT
      );
      CREATE TABLE sportlatlngbean (
        id INTEGER PRIMARY KEY, sportbean_id TEXT,
        a REAL, o REAL, ac REAL, d REAL, da REAL, s REAL, st INTEGER, sta INTEGER, t INTEGER, v INTEGER
      );
      CREATE TABLE cpacestr (id INTEGER PRIMARY KEY, sportid TEXT, km INTEGER, kmtotallength REAL, kmdlsj INTEGER, t TEXT);
      CREATE TABLE cminutespeedstr (id INTEGER PRIMARY KEY, sportid TEXT, min INTEGER, v REAL);
      CREATE TABLE customroutemodel (id INTEGER PRIMARY KEY, routeid TEXT, routename TEXT, polyline TEXT);
      CREATE TABLE exerciseattribute (
        id INTEGER PRIMARY KEY, routeid TEXT, sportname TEXT, latlng TEXT,
        minspeed REAL, maxspeed REAL, minvtime TEXT, maxvtime TEXT, vdistance REAL, vcount INTEGER, mindistanceofrunway REAL, tips TEXT
      );
    `);
    const sid = '11111111-2222-3333-4444-555555555555';
    db.prepare(`INSERT INTO sportbean VALUES (1, ?, '24', '环校跑道', '2026-10-01 18:00:00', '2026-10-01 18:20:00', 1759312800000, 3.04, '00:20:00', 1800, 9.12, '06''34''''', 90.0, 1, 1, 1, 1, '1', '1', '')`).run(sid);
    const insPt = db.prepare(`INSERT INTO sportlatlngbean VALUES (?, ?, ?, ?, 4.5, 5.05, ?, 9.12, 3, ?, ?, 1)`);
    for (let i = 0; i < 220; i++) {
      const ang = (i / 219) * Math.PI * 6;
      insPt.run(i + 1, sid, 30.0 + Math.sin(ang) * 0.001, 103.0 + Math.cos(ang) * 0.0012, (i + 1) * 14, (i + 1) * 8, 1759312800000 + i * 5000);
    }
    db.prepare(`INSERT INTO exerciseattribute VALUES (1, '24', '环校跑道', '29.995,102.995;29.995,103.005;30.005,103.005;30.005,102.995', 3, 18, '00:05:00', '02:00:00', 3.0, 5, 15, '达标有效')`).run();
    db.close();

    // 按 WCDB SQLCipher 3 规则加密成真实 ygty_mysport.db 密文页
    const plainBuf = await readFile(plainPath);
    assert.equal(plainBuf.length % 1024, 0);
    const salt = randomBytes(16);
    const key = pbkdf2Sync(Buffer.from(DEFAULT_WCDB_KEY, 'utf8'), salt, 64_000, 32, 'sha1');
    const encBuf = Buffer.alloc(plainBuf.length);
    for (let p = 0; p < plainBuf.length / 1024; p++) {
      const off = p * 1024;
      const iv = randomBytes(16);
      const plainSlice = p === 0 ? plainBuf.subarray(16, 1024 - 48) : plainBuf.subarray(off, off + 1024 - 48);
      const cip = createCipheriv('aes-256-cbc', key, iv);
      cip.setAutoPadding(false);
      const ctext = Buffer.concat([cip.update(plainSlice), cip.final()]);
      if (p === 0) {
        salt.copy(encBuf, 0);
        ctext.copy(encBuf, 16);
      } else {
        ctext.copy(encBuf, off);
      }
      iv.copy(encBuf, off + 1024 - 48);
    }
    const encDbPath = join(work, 'ygty_mysport.db');
    await writeFile(encDbPath, encBuf);
    assert.equal(decryptWcdbBuffer(encBuf).subarray(0, 16).toString('ascii'), 'SQLite format 3\0');

    // 封装成 ANDROID BACKUP (.bak) 格式（TAR + zlib 压缩）
    const tarName = 'apps/net.crigh.cgsport/db/ygty_mysport.db';
    const tarHdr = Buffer.alloc(512, 0);
    Buffer.from(tarName, 'utf8').copy(tarHdr, 0);
    Buffer.from('0000644\0', 'ascii').copy(tarHdr, 100);
    Buffer.from(encBuf.length.toString(8).padStart(11, '0') + '\0', 'ascii').copy(tarHdr, 124);
    tarHdr[156] = 0x30;
    Buffer.from('ustar\0', 'ascii').copy(tarHdr, 257);
    const padLen = Math.ceil(encBuf.length / 512) * 512 - encBuf.length;
    const tarStream = Buffer.concat([tarHdr, encBuf, Buffer.alloc(padLen + 1024, 0)]);
    const bakBuf = Buffer.concat([
      Buffer.from('ANDROID BACKUP\n5\n1\nnone\n', 'ascii'),
      deflateSync(tarStream),
    ]);
    const bakPath = join(work, '创高体育(net.crigh.cgsport).bak');
    await writeFile(bakPath, bakBuf);

    // 验证 Engine 直接导入带引号路径的 .bak 文件，并自动把账号默认路线从 27 对齐到 24！
    const store = new Store(null);
    const engine = new Engine(store, demoFetch);
    await engine.initialize();
    const acc = await engine.addAccount('测试号', 'stu99', '99');
    assert.equal(acc.routeId, '27');
    const lib = await engine.importLibrary(`"${bakPath}"`, '手机备份记录', 'private', acc.id);
    assert.equal(lib.runCount, 1);
    assert.deepEqual(lib.routeIds, ['24']);
    assert.equal(store.state.accounts[0]!.routeId, '24');

    // 验证 deleteLibrary 可安全删除记录库并清理绑定
    await engine.configure(acc.id, { libraryId: lib.id });
    assert.equal(store.state.accounts[0]!.libraryId, lib.id);
    await engine.deleteLibrary(lib.id);
    assert.equal(store.state.libraries.length, 0);
    assert.equal(store.state.accounts[0]!.libraryId, undefined);

    await engine.shutdown();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('多校并存展示与防串台、二级菜单保持字标、弹窗不丢失动态底图、人脸/随机点路线预警', async () => {
  const store = new Store(null);
  await seedDemo(store);
  const engine = new Engine(store, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/sporttype')) {
      return Response.json({
        code: 200,
        message: 'ok',
        data: [
          {
            id: 27,
            sportName: '东区环线',
            vdistance: 3,
            minVtime: '00:05:00',
            maxVtime: '02:00:00',
            isUseSensor: 1,
            isRandomWayPoint: 2,
            openStartPointFace: 1,
            isSkipStartPointFace: 0,
            latlng: '29.998,102.998;29.998,103.002;30.002,103.002;30.002,102.998',
            tips: '需起点刷脸',
          },
        ],
      });
    }
    return demoFetch(input, init);
  });
  await engine.initialize();

  // 添加两个不同高校的账号
  const accA = await engine.addAccount('一号', 'stu_alpha', {
    id: '10',
    name: '甲子大学',
    nameEn: 'Alpha Univ',
    code: 'ALPHA',
    provinceCode: '11',
    randomCode: '01',
    baseUrl: 'https://alpha-campus.example.edu.cn/cgapp-server/',
  });
  const accB = await engine.addAccount('二号', 'stu_beta', {
    id: '20',
    name: '乙丑学院',
    nameEn: 'Beta Inst',
    code: 'BETA',
    provinceCode: '22',
    randomCode: '02',
    baseUrl: 'https://beta-campus.example.edu.cn/cgapp-server/',
  });
  await engine.configure(accB.id, { proxy: 'socks5://127.0.0.1:1080' });

  // 1. 主页自动显示「学校」列 + 代理标记，且顶部标题栏随光标选中账号动态切换学校
  const idxA = store.state.accounts.findIndex(x => x.id === accA.id);
  const idxB = store.state.accounts.findIndex(x => x.id === accB.id);
  const homeSelectA = stripAnsi(frame(store.state, { screen: 'home', selected: idxA, notice: '' }, 124, 32, false, true));
  assert.match(homeSelectA, /学校\s+昵称/);
  assert.match(homeSelectA, /甲子大学 · 10/);
  assert.match(homeSelectA, /代理/);

  const homeSelectB = stripAnsi(frame(store.state, { screen: 'home', selected: idxB, notice: '' }, 124, 32, false, true));
  assert.match(homeSelectB, /乙丑学院 · 20/);

  // 2. 二级菜单（menu / manage / settings）保留 The Edge 立体字标，且弹出输入框 (form) 时右侧动态底图不消失
  const menuFrame = stripAnsi(frame(store.state, { screen: 'menu', selected: 0, notice: '' }, 120, 30, false, true));
  assert.match(menuFrame, /▄█▄/);

  const formFrame = stripAnsi(
    frame(
      store.state,
      {
        screen: 'home',
        selected: idxA,
        notice: '',
        motion: 2,
        form: { title: '登录', label: '密码', value: '', secret: true },
      },
      120,
      30,
      false,
      true,
    ),
  );
  assert.match(formFrame, /[\u2801-\u28ff]/u);

  // 3. 多校并存时修改全局默认学校配置不会误覆盖另一所高校账号的网关，且共享库按校隔离
  await engine.configureSchool('10', '');
  assert.equal(store.state.accounts[idxB]!.school.baseUrl, 'https://beta-campus.example.edu.cn/cgapp-server/');

  store.state.libraries.push({
    id: 'lib-alpha-only',
    label: '甲校共享库',
    scope: 'public',
    schoolBaseUrl: 'https://alpha-campus.example.edu.cn/cgapp-server/',
    schoolName: '甲子大学',
    runCount: 5,
    routeIds: ['27'],
    importedAt: Date.now(),
  });
  await engine.configure(accA.id, { sourceMode: 'public' });
  await engine.configure(accB.id, { sourceMode: 'public' });
  await assert.rejects(engine.prepare(accB.id, 'lib-alpha-only'), /不能使用该记录库/);

  // 4. 人脸识别与动态随机点路线自动写入学校规则提示与 One-Shot 预览风险提示
  const demoAcc = store.state.accounts[0]!;
  await engine.schoolInformation(demoAcc.id, true);
  const demoRule = store.state.accounts[0]!.information?.rules.data?.[0];
  assert.equal(demoRule?.faceAuth, true);
  assert.equal(demoRule?.dynamicWaypoints, true);
  const prepared = await engine.prepareDefault(demoAcc.id);
  assert.ok(prepared.previewWarnings?.some(w => w.includes('人脸核验')));
  assert.ok(prepared.previewWarnings?.some(w => w.includes('动态随机点位')));

  await engine.shutdown();
});
