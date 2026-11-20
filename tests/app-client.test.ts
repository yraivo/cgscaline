import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/runtime/storage.js";
import { Engine } from "../src/runtime/engine.js";
import { seedDemo, demoFetch } from "../src/core/demo.js";
import { LocalAppClient } from "../src/app/local-client.js";
import { RemoteAppClient } from "../src/app/remote-client.js";
import { execFileSync } from "node:child_process";
test("界面只拿摘要；本地草稿提交使用后台原稿，修改展示字段不改变执行快照", async () => {
  const store = new Store(null);
  await seedDemo(store);
  const e = new Engine(store, demoFetch);
  await e.initialize();
  const app = new LocalAppClient(e);
  try {
    assert.equal("store" in app, false);
    assert.equal("token" in app.state.accounts[0]!.session!, false);
    assert.equal("secret" in app.state.accounts[0]!.session!, false);
    const id = app.state.accounts[0]!.id,
      draft = await app.commands.prepareDefault(id),
      distance = draft.body.odometer;
    assert.equal("sensor" in draft, false);
    assert.equal("coordinate" in draft.body, false);
    assert.ok(draft.coordinateCount > 200);
    const forged = { ...draft, body: { ...draft.body, odometer: "99.99" } };
    const task = await app.commands.queuePrepared(
      id,
      forged,
      Date.now() + 600000,
    );
    assert.equal(task.prepared.body.odometer, distance);
    assert.equal(store.state.tasks[0]!.prepared.body.odometer, distance);
    assert.equal("sensor" in task.prepared, false);
    assert.ok(task.prepared.sensorSampleCount > 0);
    await assert.rejects(
      app.commands.queuePrepared(id, draft, Date.now() + 600000),
      /失效/,
    );
    if (false) {
      // @ts-expect-error A display draft cannot be submitted as a complete payload.
      await e.start(id, draft);
      // @ts-expect-error Session secrets do not exist in the interface model.
      void app.state.accounts[0]!.session!.token;
    }
  } finally {
    await app.close();
  }
});
test("动画帧率保存且只接受已知档位，不触发查询", async () => {
  const store = new Store(null);
  await seedDemo(store);
  let calls = 0;
  const e = new Engine(store, async () => {
    calls++;
    throw Error("network");
  });
  await e.initialize();
  const app = new LocalAppClient(e);
  try {
    assert.equal(app.state.settings.animationFps, 20);
    await app.commands.configureAppearance({ animationFps: 30 });
    assert.equal(app.state.settings.animationFps, 30);
    await app.commands.configureAppearance({ animationFps: 60 });
    assert.equal(app.state.settings.animationFps, 60);
    await assert.rejects(
      app.commands.configureAppearance({ animationFps: 15 }),
      /无效/,
    );
    assert.equal(calls, 0);
  } finally {
    await app.close();
  }
});
test("旧后台快照在客户端边界转换，界面中没有会话密钥与完整任务数组", async () => {
  const store = new Store(null);
  await seedDemo(store);
  const e = new Engine(store, demoFetch);
  await e.initialize();
  await e.queuePlan([store.state.accounts[0]!.id], Date.now() + 600000, 0);
  const remote = new RemoteAppClient();
  remote.accept({ revision: 1, state: store.state, notices: [] });
  assert.equal("token" in remote.state.accounts[0]!.session!, false);
  assert.equal("secret" in remote.state.accounts[0]!.session!, false);
  assert.equal("sensor" in remote.state.tasks[0]!.prepared, false);
  assert.equal("coordinate" in remote.state.tasks[0]!.prepared.body, false);
  await e.shutdown();
});
test("终端真实输入流跑通快捷键、密码遮罩、焦点暂停、缩放与退出，零登录提交", () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", "tests/smoke/terminal-input-smoke.ts"],
      { encoding: "utf8", timeout: 20000 },
    ),
  );
  assert.equal(result.ok, true);
  assert.equal(result.realInput, true);
  assert.equal(result.login, 0);
  assert.equal(result.submits, 0);
});
