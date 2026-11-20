import { randomUUID } from "node:crypto";
import type { Engine } from "../runtime/engine.js";
import type { Prepared } from "../core/model.js";
import { UserError } from "../core/model.js";
import { TaskScheduler } from "../runtime/task-scheduler.js";
import { ClientState, commandsFor, type Invoke } from "./client.js";
import type { AppClient, AppCommands, PreviewDraft } from "./contracts.js";
import { accountView, appState, preparedView, taskView } from "./projection.js";
export class LocalAppClient extends ClientState implements AppClient {
  readonly background = false;
  readonly connected = true;
  readonly commands: AppCommands;
  private drafts = new Map<string, { accountId: string; prepared: Prepared }>();
  private scheduler: TaskScheduler;
  constructor(private engine: Engine) {
    super();
    this.refresh();
    this.scheduler = new TaskScheduler(
      () => engine.store.state,
      () => engine.tick(),
      () => {
        this.notices.push("任务保存失败，请检查磁盘空间。");
        this.changed();
      },
    );
    engine.on("change", this.refresh);
    this.scheduler.start();
    const invoke = async (method: keyof AppCommands, args: unknown[]) => {
      try {
        if (method === "prepareDefault" || method === "prepare") {
          const p =
            method === "prepareDefault"
              ? await engine.prepareDefault(args[0] as string, args[1] as never)
              : await engine.prepare(
                  args[0] as string,
                  args[1] as string,
                  args[2] as never,
                );
          const draftId = randomUUID();
          for (const [id, d] of this.drafts)
            if (d.accountId === args[0]) this.drafts.delete(id);
          this.drafts.set(draftId, {
            accountId: args[0] as string,
            prepared: p,
          });
          return { ...preparedView(p), draftId };
        }
        if (method === "start" || method === "queuePrepared") {
          const draft = this.drafts.get((args[1] as PreviewDraft).draftId);
          if (!draft || draft.accountId !== args[0])
            throw new UserError("预览已失效，请重新生成。");
          this.drafts.delete((args[1] as PreviewDraft).draftId);
          return taskView(
            method === "start"
              ? await engine.start(args[0] as string, draft.prepared)
              : await engine.queuePrepared(
                  args[0] as string,
                  draft.prepared,
                  args[2] as number,
                ),
          );
        }
        if (method === "stopBackground") {
          await engine.shutdown();
          return;
        }
        // All names come from AppCommands; no arbitrary engine member is exposed.
        const fn = engine[method] as (...args: never[]) => Promise<unknown>;
        const value = await fn.apply(engine, args as never[]);
        if (method === "addAccount")
          return accountView(
            value as Awaited<ReturnType<Engine["addAccount"]>>,
          );
        if (method === "queuePlan")
          return (value as Awaited<ReturnType<Engine["queuePlan"]>>).map(
            taskView,
          );
        return value;
      } finally {
        this.refresh();
        this.scheduler.update();
      }
    };
    this.commands = commandsFor(invoke as Invoke);
  }
  private refresh = () => {
    this.state = appState(this.engine.store.state);
    this.notices = [...this.engine.startupNotices];
    this.changed();
  };
  async close() {
    this.scheduler.stop();
    this.engine.off("change", this.refresh);
    this.drafts.clear();
    await this.engine.shutdown();
  }
}
