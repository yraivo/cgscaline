import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { Store } from "../../src/runtime/storage.js";
import { Engine } from "../../src/runtime/engine.js";
import { seedDemo, demoFetch } from "../../src/core/demo.js";
import { LocalAppClient } from "../../src/app/local-client.js";
import { TerminalUI } from "../../src/ui/index.js";
const store = new Store(null);
await seedDemo(store);
const paths: string[] = [];
const engine = new Engine(store, async (input, init) => {
  paths.push(new URL(String(input)).pathname);
  return demoFetch(input, init);
});
await engine.initialize();
const input = Object.assign(new PassThrough(), {
  isTTY: true,
  isRaw: false,
  setRawMode(value: boolean) {
    this.isRaw = value;
    return this;
  },
  ref() {},
  unref() {},
});
let output = "";
const stdout = Object.assign(
  new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  }),
  { isTTY: true, columns: 118, rows: 38 },
);
const stderr = new Writable({
  write(_chunk, _encoding, done) {
    done();
  },
});
const ui = new TerminalUI(new LocalAppClient(engine), true, true, true, {
    stdin: input,
    stdout,
    stderr,
  }),
  done = ui.run();
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error("Terminal input timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function key(sequence: string, check?: () => boolean) {
  input.write(sequence);
  if (check) await until(check);
  await new Promise((r) => setTimeout(r, 20));
  await ui.flush();
}
try {
  await until(() => ui.frameCount > 0);
  await new Promise((r) => setTimeout(r, 30));
  await key("/", () => ui.view.screen === "menu");
  await key("\x1b", () => ui.view.screen === "home");
  await key("?", () => ui.view.screen === "menu");
  await key("\x1b", () => ui.view.screen === "home");
  await key("\x1bOP", () => ui.view.screen === "menu");
  await key("\x1b", () => ui.view.screen === "home");
  await key("/", () => ui.view.screen === "menu");
  await key("\x1b[B\x1b[B\r", () => ui.view.screen === "manage");
  await key("\r", () => !!ui.view.form);
  assert.equal(ui.view.form!.title, "登录");
  const secret = "fake-password-中文";
  await key(
    "\x1b[200~" + secret + "\x1b[201~",
    () => ui.view.form?.value === secret,
  );
  assert.equal(output.includes(secret), false);
  assert.ok(output.includes("••"));
  await key("\x15");
  await key("秘密👩‍💻", () => ui.view.form?.value === "秘密👩‍💻");
  await key("\x7f", () => ui.view.form?.value === "秘密");
  assert.equal(output.includes("秘密👩‍💻"), false);
  await key("\x1b", () => !ui.view.form && !ui.view.busy);
  await key("\x1b", () => ui.view.screen === "menu");
  await key("\x1b", () => ui.view.screen === "home");
  await key("\x1b[O");
  await new Promise((r) => setTimeout(r, 100));
  const frozen = output.length;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(output.length, frozen);
  await key("\x1b[I");
  await until(() => output.length > frozen);
  stdout.columns = 40;
  stdout.rows = 16;
  stdout.emit("resize");
  await until(() => ui.controller.width === 40 && ui.controller.height === 16);
  await key("q", () => ui.controller.closed);
  await done;
  assert.ok(output.includes("\x1b[?1049h"));
  assert.ok(output.includes("\x1b[?1049l"));
  assert.equal(input.isRaw, false);
  assert.equal(
    paths.some((p) =>
      /login|sportsId|inSportTime|savesports|sensorZipFile/.test(p),
    ),
    false,
  );
  process.stdout.write(
    JSON.stringify({
      ok: true,
      renderer: "native",
      realInput: true,
      frames: ui.frameCount,
      requests: paths.length,
      login: 0,
      submits: 0,
    }) + "\n",
  );
} finally {
  if (!ui.controller.closed) await ui.controller.quit();
  await done;
  input.destroy();
  stdout.destroy();
  stderr.destroy();
}
