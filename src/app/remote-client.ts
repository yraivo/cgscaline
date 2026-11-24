import { UserError, type Account, type Prepared, type Task } from "../core/model.js";
import type { Snapshot, WorkerChannel } from "../runtime/ipc.js";
import { ClientState, commandsFor, type Invoke } from "./client.js";
import type { AppClient, AppCommands } from "./contracts.js";
import { accountView, appState, preparedView, taskView } from "./projection.js";
export class RemoteAppClient extends ClientState implements AppClient {
  readonly background = true;
  readonly commands: AppCommands;
  private channel?: WorkerChannel;
  private revision = 0;
  private previousWorker = false;
  get connected() {
    return (
      !!this.channel &&
      !this.channel.socket.destroyed &&
      !this.channel.socket.writableEnded
    );
  }
  constructor() {
    super();
    const invoke = async (method: keyof AppCommands, args: unknown[]) => {
      if (this.previousWorker && !['stopBackground', 'pause', 'loadCachedRecords'].includes(method))
        throw new UserError("后台版本过旧，请暂停任务并重启后台后再操作。");
      const wire = [...args];
      if (method === "start" || method === "queuePrepared")
        wire[1] = (args[1] as { draftId: string }).draftId;
      const result = await this.channel!.call(method, wire);
      if (method === "prepareDefault" || method === "prepare")
        return { ...summary(result.prepared), draftId: result.draftId };
      if (method === "start" || method === "queuePrepared") return task(result);
      if (method === "queuePlan") return (result as Array<Task>).map(task);
      if (method === "addAccount")
        return "token" in (result.session ?? {})
          ? accountView(result as Account)
          : result;
      return result;
    };
    this.commands = commandsFor(invoke as Invoke);
  }
  accept = (snapshot: Snapshot) => {
    if (snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.previousWorker = snapshot.viewVersion !== 3;
    if (snapshot.viewVersion === 2) {
      const old = snapshot.state as typeof this.state;
      const accounts = old.accounts as Account[];
      this.state = { ...old, accounts: accounts.map(a => accountView(a, accounts)) };
    } else {
      this.state = snapshot.viewVersion === 3 ? snapshot.state as typeof this.state
        : appState(snapshot.state as import("../core/model.js").State);
    }
    this.notices = [...snapshot.notices];
    if (this.previousWorker) this.notices.push("旧后台运行中，请暂停任务并重启以启用设备保护。");
    this.changed();
  };
  attach(channel: WorkerChannel) {
    this.channel = channel;
    channel.socket.on("close", () => {
      this.notices.push("后台已断开，请重新打开。");
      this.changed();
    });
  }
  async close() {
    this.channel?.close();
  }
}
function summary(p: Prepared | import("./contracts.js").PreparedSummary) {
  return "kind" in p && p.kind === "summary" ? p : preparedView(p as Prepared);
}
function task(t: Task | import("./contracts.js").TaskView) {
  return "kind" in t.prepared
    ? (t as import("./contracts.js").TaskView)
    : taskView(t as Task);
}
