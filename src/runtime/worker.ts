import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandNames, type AppClient } from "../app/contracts.js";
import {
  accountView,
  appState,
  preparedView,
  taskView,
} from "../app/projection.js";
import { RemoteAppClient } from "../app/remote-client.js";
import { APP_NAME } from "../core/brand.js";
import { Engine } from "./engine.js";
import { UserError, safeText, type Prepared } from "../core/model.js";
import { TaskNotifications, desktopNotify } from "./notifications.js";
import {
  WORKER_BUILD_REV,
  WorkerChannel,
  proof,
  receive,
  send,
  verified,
  type Snapshot,
  type WorkerAddress,
} from "./ipc.js";
import { Store, WindowsVault, unlockStale } from "./storage.js";
import { TaskScheduler } from "./task-scheduler.js";

const methods = new Set<string>(commandNames);
const descriptorPath = (root: string) => join(root, "worker.dpapi");
export const isAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
async function readAddress(root: string): Promise<WorkerAddress | undefined> {
  try {
    const value = JSON.parse(
      (
        await new WindowsVault().unprotect(await readFile(descriptorPath(root)))
      ).toString("utf8"),
    ) as WorkerAddress;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.pipe !== "string" ||
      typeof value.demo !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(value.key)
    )
      throw Error();
    return value;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new UserError("无法读取后台连接信息。");
  }
}
export async function runWorker(
  root: string,
  demo = false,
  notifications = true,
) {
  process.title = `${APP_NAME} worker`;
  const store = new Store(root);
  await store.open();
  if (
    (demo &&
      store.state.runtimeMode !== "demo" &&
      (store.state.accounts.length ||
        store.state.tasks.length ||
        store.state.libraries.length)) ||
    (!demo && store.state.runtimeMode === "demo")
  ) {
    store.close();
    throw new UserError("演示与真实档案不能混用，请使用独立目录。");
  }
  if (demo) store.state.runtimeMode = "demo";
  const demoSupport = demo ? await import("../core/demo.js") : undefined;
  const engine = new Engine(store, demoSupport?.demoFetch);
  const sockets = new Set<Socket>();
  let revision = 0,
    stopping = false,
    broadcastTimer: NodeJS.Timeout | undefined;
  let scheduler: TaskScheduler | undefined;
  const snapshot = (): Snapshot => ({
    revision: ++revision,
    state: appState(store.state),
    viewVersion: 2,
    notices: engine.startupNotices,
  });
  const notifier = new TaskNotifications(
    store.state,
    notifications ? desktopNotify : () => {},
  );
  const address: WorkerAddress = {
    version: 1,
    pid: process.pid,
    key: randomBytes(32).toString("hex"),
    demo,
    startedAt: Date.now(),
    rev: WORKER_BUILD_REV,
    pipe:
      process.platform === "win32"
        ? `\\\\.\\pipe\\cgscaline-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}-${randomBytes(12).toString("hex")}`
        : join(tmpdir(), `cgscaline-${randomBytes(12).toString("hex")}.sock`),
  };
  let commandQueue = Promise.resolve();
  const server = createServer((socket) => {
    const nonce = randomBytes(32).toString("hex");
    let authenticated = false,
      inflight = 0;
    const drafts = new Map<
      string,
      { accountId: string; prepared: Prepared; at: number }
    >();
    const authTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      drafts.clear();
    });
    send(socket, {
      type: "challenge",
      nonce,
      proof: proof(address.key, "server:" + nonce),
    });
    receive(socket, 64_000, (message) => {
      if (!authenticated) {
        if (
          message.type !== "auth" ||
          typeof message.nonce !== "string" ||
          message.nonce.length !== 64 ||
          !verified(
            message.proof,
            proof(address.key, "client:" + nonce + ":" + message.nonce),
          )
        ) {
          socket.destroy();
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        sockets.add(socket);
        send(socket, {
          type: "ready",
          proof: proof(address.key, "ready:" + nonce + ":" + message.nonce),
          snapshot: snapshot(),
        });
        return;
      }
      if (
        message.type !== "call" ||
        !Number.isSafeInteger(message.id) ||
        typeof message.method !== "string" ||
        !Array.isArray(message.args) ||
        inflight >= 16
      ) {
        socket.destroy();
        return;
      }
      inflight++;
      const operation = async () => {
        try {
          if (stopping) throw new UserError("后台正在停止。");
          const args = (message.args as any[]).map((v) =>
              v === null ? undefined : v,
            ),
            method = message.method as string;
          let value: any;
          if (method === "prepareDefault" || method === "prepare") {
            const p =
              method === "prepareDefault"
                ? await engine.prepareDefault(args[0], args[1])
                : await engine.prepare(args[0], args[1], args[2]);
            for (const [key, d] of drafts)
              if (Date.now() - d.at > 30 * 60_000 || d.accountId === args[0])
                drafts.delete(key);
            if (drafts.size >= 32) drafts.delete(drafts.keys().next().value!);
            const draftId = randomUUID();
            drafts.set(draftId, {
              accountId: args[0],
              prepared: p,
              at: Date.now(),
            });
            value = { draftId, prepared: preparedView(p) };
          } else if (method === "start" || method === "queuePrepared") {
            const draft = drafts.get(args[1]);
            if (
              !draft ||
              draft.accountId !== args[0] ||
              Date.now() - draft.at > 30 * 60_000
            )
              throw new UserError("预览已失效，请重新生成。");
            drafts.delete(args[1]);
            value = taskView(
              method === "start"
                ? await engine.start(args[0], draft.prepared)
                : await engine.queuePrepared(args[0], draft.prepared, args[2]),
            );
          } else if (method === "stopBackground") {
            scheduler?.stop();
            try {
              await engine.shutdown();
            } catch (e) {
              scheduler?.start();
              throw e;
            }
            stopping = true;
            value = true;
          } else {
            if (!methods.has(method)) throw new UserError("不支持的后台操作。");
            value = await (engine as any)[method](...args);
            if (method === "queuePlan") value = value.map(taskView);
            if (method === "addAccount") value = accountView(value);
          }
          send(socket, {
            type: "reply",
            id: message.id,
            value,
            snapshot: snapshot(),
          });
          engine.emit("change");
          if (stopping) setTimeout(() => void close(), 100);
        } catch (error) {
          send(socket, {
            type: "reply",
            id: message.id,
            error:
              error instanceof UserError
                ? safeText(error.message, 600)
                : "后台操作失败，请检查设置。",
            snapshot: snapshot(),
          });
        } finally {
          inflight--;
        }
      };
      commandQueue = commandQueue.then(operation, operation);
    });
  });
  server.maxConnections = 32;
  const changed = () => {
    scheduler?.update();
    notifier.update(store.state);
    if (!broadcastTimer)
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined;
        if (!sockets.size) return;
        const current = snapshot();
        for (const socket of sockets)
          send(socket, { type: "state", snapshot: current });
      }, 40);
  };
  let storageFailed = false;
  const tick = async () => {
    await engine.tick();
    storageFailed = false;
  };
  const failed = () => {
    if (storageFailed) return;
    storageFailed = true;
    engine.startupNotices.push("保存失败，请检查磁盘空间。");
    changed();
    if (notifications && store.state.settings.notifications !== false)
      desktopNotify("保存失败，请检查磁盘空间。");
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    scheduler?.stop();
    if (broadcastTimer) clearTimeout(broadcastTimer);
    notifier.close();
    engine.off("change", changed);
    for (const socket of sockets) socket.end();
    await new Promise<void>((resolveDone) => server.close(() => resolveDone()));
    try {
      const old = await readAddress(root);
      if (old?.pid === process.pid) await unlink(descriptorPath(root));
    } catch {}
    if (process.platform !== "win32")
      await unlink(address.pipe).catch(() => {});
    process.off("SIGTERM", signal);
    process.off("SIGINT", signal);
  };
  const signal = () => {
    commandQueue = commandQueue.then(async () => {
      if (stopping) return;
      scheduler?.stop();
      try {
        await engine.shutdown();
        stopping = true;
        await close();
      } catch {
        scheduler?.start();
      }
    });
  };
  try {
    if (demoSupport && !store.state.accounts.length)
      await demoSupport.seedDemo(store);
    await engine.initialize();
    engine.on("change", changed);
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(address.pipe, () => {
        server.off("error", reject);
        resolveReady();
      });
    });
    const temp = descriptorPath(root) + "." + randomUUID() + ".tmp";
    await writeFile(
      temp,
      await new WindowsVault().protect(Buffer.from(JSON.stringify(address))),
      { flag: "wx", mode: 0o600 },
    );
    await rename(temp, descriptorPath(root));
    process.on("SIGTERM", signal);
    process.on("SIGINT", signal);
    scheduler = new TaskScheduler(() => store.state, tick, failed);
    scheduler.start();
    if (
      notifications &&
      store.state.settings.notifications !== false &&
      store.state.tasks.some((t) => ["paused", "review"].includes(t.phase))
    )
      desktopNotify("有暂停或待核对任务，打开 CGSCALINE → 任务处理。");
    return { engine, address, close: signal };
  } catch (e) {
    store.close();
    server.close();
    throw e;
  }
}

export async function connectWorker(
  root: string,
  options: {
    demo?: boolean;
    start?: boolean;
    entry?: string;
    notifications?: boolean;
  } = {},
): Promise<AppClient> {
  const client = new RemoteAppClient();
  let channel: WorkerChannel | undefined;
  const attach = async (address: WorkerAddress) => {
    if (address.demo !== !!options.demo)
      throw new UserError("此档案的后台模式不匹配；演示档案必须独立。");
    channel = await WorkerChannel.connect(address, client.accept);
  };
  let old = await readAddress(root);
  if (old && isAlive(old.pid) && options.start !== false && options.entry) {
    const entryMtime = (await stat(options.entry).catch(() => undefined))?.mtimeMs ?? 0;
    if (entryMtime > old.startedAt || old.rev !== WORKER_BUILD_REV) {
      try {
        if (old.demo !== !!options.demo)
          throw new UserError("此档案的后台模式不匹配；演示档案必须独立。");
        const probeClient = new RemoteAppClient();
        const probeChannel = await WorkerChannel.connect(old, probeClient.accept);
        probeClient.attach(probeChannel);
        if (!probeClient.state.tasks.some((t) => ["starting", "waiting", "committing"].includes(t.phase))) {
          await probeClient.commands.stopBackground();
          await probeClient.close();
          const stopDeadline = Date.now() + 5000;
          while (Date.now() < stopDeadline && isAlive(old.pid)) await new Promise((r) => setTimeout(r, 50));
          old = undefined;
        } else {
          return probeClient;
        }
      } catch {
        channel = undefined;
        old = await readAddress(root);
      }
    }
  }
  if (old && isAlive(old.pid)) {
    await attach(old);
  } else {
    if (options.start === false) throw new UserError("后台未运行。");
    if (!options.entry) throw new UserError("缺少后台启动入口。");
    await mkdir(root, { recursive: true });
    if (existsSync(join(root, "instance.lock"))) {
      try {
        unlockStale(root);
      } catch {
        throw new UserError(
          "旧版或另一个后台仍在使用此档案。请等待任务结束并退出旧版，再启动 CGSCALINE。",
        );
      }
    }
    const seaMod = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => { isSea?: () => boolean } }).getBuiltinModule?.("node:sea");
    const selfExecutable = Boolean(seaMod?.isSea?.()) || options.entry === process.execPath;
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        ...(selfExecutable ? [] : [options.entry]),
        "--worker",
        "--data-dir",
        root,
        ...(options.demo ? ["--demo"] : []),
        ...(options.notifications === false ? ["--no-notifications"] : []),
      ],
      { detached: true, windowsHide: true, stdio: "ignore" },
    );
    child.unref();
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    const deadline = Date.now() + 45_000;
    let lastMtime = 0;
    while (Date.now() < deadline && !failed && !channel) {
      try {
        const stamp = (await stat(descriptorPath(root))).mtimeMs;
        if (stamp !== lastMtime) {
          lastMtime = stamp;
          const address = await readAddress(root);
          if (address && isAlive(address.pid)) await attach(address);
        }
      } catch {}
      if (!channel) await new Promise((r) => setTimeout(r, 200));
    }
    if (!channel)
      throw new UserError("后台启动失败。运行 --worker 可查看详情。");
  }
  client.attach(channel!);
  return client;
}
