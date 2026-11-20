import type { Account, Prepared, Task } from "../core/model.js";
import type { Snapshot, WorkerChannel } from "../runtime/ipc.js";
import { ClientState, commandsFor, type Invoke } from "./client.js";
import type { AppClient, AppCommands } from "./contracts.js";
import { accountView, appState, preparedView, taskView } from "./projection.js";
export class RemoteAppClient extends ClientState implements AppClient {
  readonly background = true;
  readonly commands: AppCommands;
  private channel?: WorkerChannel;
  private revision = 0;
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
    this.state =
      snapshot.viewVersion === 2
        ? (snapshot.state as typeof this.state)
        : appState(snapshot.state as import("../core/model.js").State);
    this.notices = [...snapshot.notices];
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
