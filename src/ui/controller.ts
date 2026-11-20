import { EventEmitter } from "node:events";
import type { AccountView, AppClient } from "../app/contracts.js";
import { animationRates, resolveAnimationFps, visualOpacities, resolveVisualOpacity } from "../render/appearance.js";
import {
  colorThemes,
  fontNames,
  resolveFont,
  resolveTheme,
  resolveVisual,
  visualNames,
} from "../render/chroma.js";
import { dateTime, informationLines, schoolLines } from "./information-view.js";
import { languages, localizeBackendText, resolveLanguage, tr } from "../core/i18n.js";
import {
  filterFonts,
  gradientSpeeds,
  resolveGradientSpeed,
} from "../render/logo-fonts.js";
import {
  activeTask,
  cachedInformation,
  safeText,
  UserError,
  type LogoFont,
  type VisualStyle,
} from "../core/model.js";
import { oneShotLines } from "./oneshot-view.js";
import { visibleTasks } from "./task-view.js";
import {
  accountActions,
  appearanceActions,
  manageActions,
  moreActions,
  settingActions,
  type View,
} from "../render/theme.js";
import { AccountWorkflow } from "./accounts-workflow.js";
import { pageKeyAction, type InputKey } from "./input.js";
import { resolveCampusLabel } from "./pages.js";
import { OneShotWorkflow } from "./shots-workflow.js";
import { WorkoutPages, workoutPageActions } from "./workout-pages.js";
import { TaskPages, taskPageActions } from "./task-pages.js";

type Prompt = {
  value: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type NavSnapshot = Pick<
  View,
  | "screen"
  | "selected"
  | "accountId"
  | "historyScope"
  | "history"
  | "historyFetchedAt"
  | "infoTab"
  | "title"
  | "lines"
  | "detailRecord"
  | "detailMinimap"
  | "noticeId"
  | "preview"
  | "advanced"
  | "fontQuery"
>;

export class UIController extends EventEmitter {
  readonly accounts = new AccountWorkflow(this);
  readonly shots = new OneShotWorkflow(this);
  readonly workouts = new WorkoutPages(this);
  readonly tasks = new TaskPages(this);
  view: View = { screen: "home", selected: 0, notice: "", marked: [] };
  private navStack: NavSnapshot[] = [];
  private prompt?: Prompt;
  closed = false;
  revision = 0;
  private unsubscribe?: () => void;
  private closing?: Promise<void>;
  width = 100;
  height = 38;
  constructor(
    readonly app: AppClient,
    readonly demo = false,
    readonly color = true,
    readonly motion = true,
  ) {
    super();
  }
  private get lang() {
    return resolveLanguage(this.app.state.settings.language);
  }
  subscribe = (listener: () => void) => {
    this.on("change", listener);
    return () => {
      this.off("change", listener);
    };
  };
  snapshot = () => this.revision;
  start() {
    this.view.notice = this.app.notices.join(" ");
    this.unsubscribe = this.app.subscribe(this.changed);
  }
  render() {
    this.tasks.syncDeadline();
    this.revision++;
    this.emit("change");
  }
  private changed = () => {
    if (!this.app.connected)
      this.view.notice = tr(
        this.lang,
        "后台已断开，请重新打开。",
        "Daemon disconnected; please reopen.",
      );
    if (this.view.taskChecks) {
      for (const [tid, check] of Object.entries(this.view.taskChecks)) {
        if (check.kind !== "result") continue;
        const t = this.app.state.tasks.find((x) => x.id === tid);
        if (!t || (t.audit && t.audit.checkedAt > check.audit.checkedAt))
          delete this.view.taskChecks[tid];
      }
    }
    this.render();
  };
  account(id: string) {
    const a = this.app.state.accounts.find((a) => a.id === id);
    if (!a)
      throw new UserError(tr(this.lang, "账号不存在。", "Account not found."));
    return a;
  }
  hasTask(id: string) {
    return this.app.state.tasks.some(
      (t) => t.accountId === id && activeTask(t),
    );
  }
  handle = (ch: string, key: InputKey) => {
    if (this.closed) return;
    if (this.prompt) {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        const p = this.prompt;
        this.prompt = undefined;
        this.view.form = undefined;
        p.reject(new UserError(tr(this.lang, "已取消。", "Cancelled.")));
      } else if (key.name === "return") {
        const p = this.prompt,
          secret = this.view.form?.secret;
        this.prompt = undefined;
        this.view.form = undefined;
        p.resolve(secret ? p.value : p.value.trim());
      } else if (key.name === "backspace") {
        this.prompt.value = Array.from(
          new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(
            this.prompt.value,
          ),
          (v) => v.segment,
        )
          .slice(0, -1)
          .join("");
        this.view.form!.value = this.prompt.value;
      } else if (key.ctrl && key.name === "u") {
        this.prompt.value = "";
        this.view.form!.value = "";
      } else if (
        !key.ctrl &&
        !key.meta &&
        ch &&
        !ch.includes("\x1b") &&
        !/^[\x00-\x1f\x7f]/.test(ch)
      ) {
        this.prompt.value = (this.prompt.value + safeText(ch, 1024)).slice(
          0,
          2048,
        );
        this.view.form!.value = this.prompt.value;
      }
      this.render();
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (this.view.busy) {
        this.view.notice = tr(
          this.lang,
          "正在处理，请稍候。",
          "Operation in progress, please wait.",
        );
        this.render();
        return;
      }
      void this.action(() => this.quit());
      return;
    }
    if (this.view.busy) return;
    const workoutActions = workoutPageActions(this.view, this.app.state);
    const taskActions = taskPageActions(this.view, this.app.state, this.demo);
    const pageActions = workoutActions ?? taskActions;
    const workoutAction =
      workoutActions && pageKeyAction(workoutActions, ch, key);
    const taskAction = taskActions && pageKeyAction(taskActions, ch, key);
    const pageAction = workoutAction ?? taskAction;
    if (pageActions && !pageAction) return;
    if (
      pageAction?.command === "back" ||
      (!pageActions && key.name === "escape")
    ) {
      this.back();
      this.render();
      return;
    }
    if (
      this.view.screen === "school" &&
      (["left", "right"].includes(key.name ?? "") || /^[12]$/.test(ch ?? ""))
    ) {
      this.view.infoTab = /^[12]$/.test(ch ?? "")
        ? Number(ch) - 1
        : ((this.view.infoTab ?? 0) + 1) % 2;
      this.view.selected = 0;
      this.render();
      return;
    }
    if (
      (this.view.screen === "school" || this.view.screen === "notices") &&
      key.name === "tab"
    ) {
      const accounts = this.app.state.accounts;
      if (accounts.length)
        this.view.accountId =
          accounts[
            (accounts.findIndex((a) => a.id === this.view.accountId) + 1) %
              accounts.length
          ]!.id;
      this.view.selected = 0;
      this.render();
      return;
    }
    if (
      pageAction?.command === "move" ||
      (!pageActions &&
        ["up", "down", "pageup", "pagedown", "home", "end"].includes(
          key.name ?? "",
        ))
    ) {
      const n = this.count(),
        scroll = [
          "information",
          "school",
          "records",
          "fonts",
          "oneshot",
        ].includes(this.view.screen);
      const delta =
        key.name === "pageup"
          ? -Math.max(1, this.height - 12)
          : key.name === "pagedown"
            ? Math.max(1, this.height - 12)
            : key.name === "down"
              ? 1
              : -1;
      this.view.selected =
        key.name === "home"
          ? 0
          : key.name === "end"
            ? n - 1
            : scroll || key.name === "pageup" || key.name === "pagedown"
              ? Math.max(0, Math.min(n - 1, this.view.selected + delta))
              : (this.view.selected + delta + n) % n;
      if (taskActions) this.view.notice = "";
      this.render();
      return;
    }
    if (
      taskAction &&
      taskAction.command !== "move" &&
      taskAction.command !== "back"
    ) {
      const command = taskAction.command;
      void this.action(() => this.tasks.run(command));
      return;
    }
    if (
      workoutAction &&
      workoutAction.command !== "move" &&
      workoutAction.command !== "back"
    ) {
      const command = workoutAction.command;
      void this.action(() => this.workouts.run(command));
      return;
    }
    if (!this.acceptsCommand(ch, key)) return;
    void this.action(async () => {
      if (this.view.screen === "menu") {
        if (key.name === "return") return this.moreAction(this.view.selected);
        return;
      }
      if (this.view.screen === "fonts") {
        if (ch === "/") {
          this.view.fontQuery = await this.ask(
            tr(this.lang, "查找字标", "FILTER WORDMARKS"),
            tr(
              this.lang,
              "字体名称；留空显示全部",
              "Font name; blank shows all",
            ),
            this.view.fontQuery ?? "",
          );
          this.view.selected = 0;
          return;
        }
        if (key.name === "return") {
          const font = filterFonts(this.view.fontQuery)[this.view.selected];
          if (!font) return;
          await this.app.commands.configureAppearance({ logoFont: font });
          this.back();
          return;
        }
        return;
      }
      if (
        this.view.screen === "appearance" &&
        ["return", "left", "right"].includes(key.name ?? "")
      ) {
        if (key.name === "return" && this.view.selected === 1) {
          this.navigate("fonts");
          this.view.fontQuery = "";
          this.view.selected = filterFonts().indexOf(
            resolveFont(this.app.state.settings.logoFont),
          );
          return;
        }
        return this.changeAppearance(key.name === "left" ? -1 : 1);
      }
      if (this.view.screen === "home") {
        if (["?", "/", "？", "／"].includes(ch) || key.name === "f1") {
          this.view.accountId =
            this.app.state.accounts[this.view.selected]?.id;
          this.navigate("menu");
          return;
        }
        if (ch?.toLowerCase() === "q") return this.quit();
        if (ch?.toLowerCase() === "t") return this.navigate("tasks");
        if (ch?.toLowerCase() === "h") return this.navigate("executions");
        if (ch?.toLowerCase() === "p") return this.shots.plan();
        if (ch?.toLowerCase() === "n") return this.showNotices();
        if (ch?.toLowerCase() === "c") return this.checkSchool();
        if (ch?.toLowerCase() === "x" || ch === "*")
          return this.togglePrivacy();
        if (ch?.toLowerCase() === "l") return this.toggleLanguage();
        if (ch?.toLowerCase() === "v") return this.nextColorTheme();
        if (key.name === "space") {
          const a = this.app.state.accounts[this.view.selected];
          if (!a) return;
          const marked = new Set(this.view.marked);
          marked.has(a.id) ? marked.delete(a.id) : marked.add(a.id);
          this.view.marked = [...marked];
          return;
        }
        if (key.name === "return") {
          const a = this.app.state.accounts[this.view.selected];
          if (a) {
            this.view.accountId = a.id;
            this.navigate("account");
          } else await this.accounts.add();
        }
      } else if (this.view.screen === "account" && key.name === "return")
        await this.accounts.accountAction();
      else if (this.view.screen === "manage" && key.name === "return")
        await this.accounts.manageAction();
      else if (this.view.screen === "information" && ch?.toLowerCase() === "r")
        await this.app.commands.information(this.current().id, true);
      else if (this.view.screen === "school" && ch?.toLowerCase() === "r")
        await this.app.commands.schoolInformation(this.current().id, true);
      else if (this.view.screen === "notices") {
        const a = this.current();
        if (ch?.toLowerCase() === "r") {
          const info = await this.app.commands.schoolNotices(a.id, true);
          const count = info.notices?.data?.length ?? 0;
          this.view.selected = Math.min(
            this.view.selected,
            Math.max(0, count - 1),
          );
          return;
        }
        if (key.name === "return") {
          const item =
            cachedInformation(a)?.notices?.data?.[this.view.selected];
          if (!item) return;
          const lines = await this.app.commands.noticeDetail(a.id, item.id);
          this.navigate("records");
          this.view.title = tr(this.lang, "通知详情", "NOTICE DETAIL");
          this.view.returnTo = "notices";
          this.view.noticeId = item.id;
          this.view.lines = lines;
          return;
        }
      } else if (this.view.screen === "manage" && ch?.toLowerCase() === "c") {
        const a = this.current(),
          result = await this.app.commands.check(a.id);
        const note = localizeBackendText(result.note, this.lang);
        this.view.notice =
          this.lang === "en"
            ? `${a.proxy ? "Proxy" : "Direct"} probe: ${note}`
            : `${a.proxy ? "账号代理" : "账号直连"}检查：${note}`;
      } else if (this.view.screen === "libraries") {
        const lower = ch?.toLowerCase() ?? "";
        if (lower === "i") return this.accounts.import();
        if (lower === "p") return this.accounts.importFromPhone();
        if (lower === "d") {
          const lib = this.app.state.libraries[this.view.selected];
          if (!lib) return;
          await this.confirm(
            tr(this.lang, "删除记录库", "DELETE LIBRARY"),
            this.lang === "en"
              ? `Delete track library "${lib.label}" (${lib.runCount} runs)?`
              : `确认删除记录库「${lib.label}」（${lib.runCount} 条记录）？`,
          );
          await this.app.commands.deleteLibrary(lib.id);
          this.view.selected = Math.max(0, Math.min(this.view.selected, this.app.state.libraries.length - 1));
          this.view.notice = tr(this.lang, "记录库已删除。", "Track library deleted.");
          return;
        }
        if (key.name === "return") {
          const lib = this.app.state.libraries[this.view.selected];
          if (!lib) {
            const way = (
              await this.ask(
                tr(this.lang, "导入运动记录", "IMPORT WORKOUT DATA"),
                tr(
                  this.lang,
                  "1 选择本地文件 (.db / .bak / .zip / .json) / 2 连接安卓手机读取 (ADB)",
                  "1 Local file (.db / .bak / .zip / .json) / 2 Read from Android phone (ADB)",
                ),
                "1",
              )
            ).trim();
            return way === "2"
              ? this.accounts.importFromPhone()
              : this.accounts.import();
          }
          const owner = lib.ownerAccountId
            ? this.app.state.accounts.find((x) => x.id === lib.ownerAccountId)
            : undefined;
          this.navigate("records");
          this.view.title = tr(this.lang, "记录库详情", "LIBRARY DETAIL");
          this.view.lines =
            this.lang === "en"
              ? [
                  `Name         ${lib.label}`,
                  `Scope        ${lib.scope === "private" ? `Private (${owner?.label ?? "—"})` : "Shared on this machine"}`,
                  `Track Count  ${lib.runCount} runs`,
                  `Routes       ${lib.routeIds.join(" / ") || "—"}`,
                  `Imported At  ${dateTime(lib.importedAt)}`,
                ]
              : [
                  `名称      ${lib.label}`,
                  `可用范围  ${lib.scope === "private" ? `私人（${owner?.label ?? "—"}）` : "本机共享"}`,
                  `样本数量  ${lib.runCount} 条`,
                  `包含路线  ${lib.routeIds.join(" / ") || "—"}`,
                  `导入时间  ${dateTime(lib.importedAt)}`,
                ];
          return;
        }
      } else if (this.view.screen === "settings") {
        if (["left", "right"].includes(key.name ?? "")) {
          return this.stepSetting(key.name === "left" ? -1 : 1);
        }
        if (key.name === "return") {
          if (this.view.selected === 0) await this.schoolSettings();
          else if (this.view.selected === 1) {
            const n = Number(
              await this.ask(
                tr(this.lang, "并发上限", "MAX CONCURRENCY"),
                tr(
                  this.lang,
                  "同时运行几个账号（1–16）",
                  "Concurrent active sessions (1–16)",
                ),
                String(this.app.state.settings.maxConcurrent),
              ),
            );
            if (!Number.isInteger(n) || n < 1 || n > 16)
              throw new UserError(
                tr(
                  this.lang,
                  "并发上限需为 1–16 的整数。",
                  "Max concurrency must be 1–16.",
                ),
              );
            await this.app.commands.configureSettings({ maxConcurrent: n });
            this.view.notice =
              this.lang === "en"
                ? `Max concurrency set to ${n}.`
                : `并发上限已设为 ${n}。`;
          } else if (this.view.selected === 2) {
            this.navigate("libraries");
          } else if (this.view.selected === 3) {
            this.navigate("appearance");
          } else if (this.view.selected === 4) {
            await this.toggleNotifications();
          } else if (this.view.selected === 5) {
            const raw = await this.ask(
              tr(this.lang, "学期目标次数", "SEMESTER TARGET"),
              tr(
                this.lang,
                "本学期考核目标次数（1–300，输入 0 或留空清除）",
                "Target valid runs for this semester (1–300, 0 or blank to clear)",
              ),
              this.app.state.settings.termTarget
                ? String(this.app.state.settings.termTarget)
                : "",
            );
            const n = raw === "" ? 0 : Number(raw);
            if (!Number.isInteger(n) || n < 0 || n > 300)
              throw new UserError(
                tr(
                  this.lang,
                  "学期目标次数需为 0–300 的整数。",
                  "Target must be an integer 0–300.",
                ),
              );
            await this.app.commands.configureSettings({ termTarget: n });
            this.view.notice =
              n > 0
                ? this.lang === "en"
                  ? `Semester target set to ${n} runs.`
                  : `学期目标已设为 ${n} 次。`
                : tr(
                    this.lang,
                    "已清除学期目标次数。",
                    "Semester target cleared.",
                  );
          } else if (this.view.selected === 6) {
            await this.exportBackupFlow();
          } else if (this.view.selected === 7) {
            await this.importBackupFlow();
          } else if (this.view.selected === 8) {
            await this.confirm(
              tr(this.lang, "停止后台", "STOP DAEMON"),
              tr(
                this.lang,
                "暂停等待和排队任务，停止后台并关闭界面？",
                "Pause active/queued tasks, stop daemon, and exit?",
              ),
            );
            await this.app.commands.stopBackground();
            return this.quit();
          } else if (this.view.selected === 9) {
            this.back();
          }
        }
      }
    });
  };
  private acceptsCommand(ch: string, key: InputKey) {
    const screen = this.view.screen,
      char = ch?.toLowerCase() ?? "";
    if (key.name === "return")
      return [
        "home",
        "menu",
        "account",
        "manage",
        "settings",
        "libraries",
        "fonts",
        "appearance",
        "notices",
      ].includes(screen);
    if (screen === "home")
      return (
        key.name === "f1" ||
        key.name === "space" ||
        [
          "?",
          "/",
          "？",
          "／",
          "q",
          "t",
          "h",
          "p",
          "n",
          "c",
          "x",
          "*",
          "l",
          "v",
        ].includes(char)
      );
    if (screen === "appearance" || screen === "settings")
      return ["left", "right"].includes(key.name ?? "");
    if (screen === "fonts") return char === "/";
    if (screen === "manage") return char === "c";
    if (screen === "libraries") return char === "i" || char === "p" || char === "d";
    if (["information", "school", "notices"].includes(screen))
      return char === "r";
    return false;
  }
  private count() {
    const s = this.app.state;
    return Math.max(
      1,
      this.view.screen === "home"
        ? s.accounts.length + 1
        : this.view.screen === "account"
          ? accountActions.length
          : this.view.screen === "manage"
            ? manageActions.length
            : this.view.screen === "settings"
              ? settingActions.length
              : this.view.screen === "menu"
                ? moreActions.length
                : this.view.screen === "tasks" ||
                    this.view.screen === "executions"
                  ? visibleTasks(s, this.view.screen === "executions").length
                  : this.view.screen === "libraries"
                    ? s.libraries.length
                    : this.view.screen === "history"
                      ? (this.view.history?.length ?? 1)
                      : this.view.screen === "information"
                        ? informationLines(
                            this.current(),
                            s.settings.termTarget,
                            this.lang,
                          ).length
                        : this.view.screen === "school"
                          ? this.view.accountId
                            ? schoolLines(
                                this.current(),
                                this.view.infoTab,
                                this.lang,
                              ).length
                            : 1
                          : this.view.screen === "notices"
                            ? this.view.accountId
                              ? (cachedInformation(this.current())?.notices
                                  ?.data?.length ?? 1)
                              : 1
                            : this.view.screen === "appearance"
                              ? appearanceActions.length
                              : this.view.screen === "fonts"
                                ? filterFonts(this.view.fontQuery).length
                                : this.view.screen === "oneshot"
                                  ? this.view.preview
                                    ? oneShotLines(this.view.preview, this.lang)
                                        .length
                                    : 1
                                  : this.view.screen === "records"
                                    ? (this.view.lines?.length ?? 1)
                                    : 1,
    );
  }
  private captureNavSnapshot(): NavSnapshot {
    return {
      screen: this.view.screen,
      selected: this.view.selected,
      accountId: this.view.accountId,
      historyScope: this.view.historyScope,
      history: this.view.history,
      historyFetchedAt: this.view.historyFetchedAt,
      infoTab: this.view.infoTab,
      title: this.view.title,
      lines: this.view.lines,
      detailRecord: this.view.detailRecord,
      detailMinimap: this.view.detailMinimap,
      noticeId: this.view.noticeId,
      preview: this.view.preview,
      advanced: this.view.advanced,
      fontQuery: this.view.fontQuery,
    };
  }
  navigate(screen: View["screen"]) {
    if (screen === "home") {
      this.navStack.length = 0;
      this.view.taskChecks = undefined;
    } else if (this.view.screen !== screen) {
      const existing = this.navStack.findIndex((f) => f.screen === screen);
      if (existing >= 0) {
        this.navStack.length = existing;
      } else {
        this.navStack.push(this.captureNavSnapshot());
      }
    }
    if (screen !== "history" && screen !== "records")
      this.view.historyScope = undefined;
    this.view.screen = screen;
    this.view.selected = 0;
    this.view.lines = undefined;
    this.view.detailRecord = undefined;
    this.view.detailMinimap = undefined;
    this.view.noticeId = undefined;
    this.view.preview = undefined;
    this.view.notice = "";
    this.view.title = undefined;
    this.view.returnTo = undefined;
  }
  /** Jump directly to a top-level destination screen whose Esc returns to Home. */
  openTop(screen: View["screen"]) {
    this.navStack = [
      {
        screen: "home",
        selected: Math.min(
          Math.max(
            0,
            this.app.state.accounts.findIndex(
              (a) => a.id === this.view.accountId,
            ),
          ),
          this.app.state.accounts.length,
        ),
        accountId: this.view.accountId,
      },
    ];
    this.view.screen = screen;
    this.view.selected = 0;
    this.view.lines = undefined;
    this.view.detailRecord = undefined;
    this.view.detailMinimap = undefined;
    this.view.noticeId = undefined;
    this.view.preview = undefined;
    this.view.notice = "";
    this.view.title = undefined;
    this.view.returnTo = undefined;
  }
  back() {
    const prev = this.navStack.pop();
    if (prev) {
      if (prev.screen === "home") this.view.taskChecks = undefined;
      this.view.screen = prev.screen;
      this.view.accountId = prev.accountId;
      this.view.historyScope = prev.historyScope;
      this.view.history = prev.history;
      this.view.historyFetchedAt = prev.historyFetchedAt;
      this.view.infoTab = prev.infoTab;
      this.view.title = prev.title;
      this.view.lines = prev.lines;
      this.view.detailRecord = prev.detailRecord;
      this.view.detailMinimap = prev.detailMinimap;
      this.view.noticeId = prev.noticeId;
      this.view.preview = prev.preview;
      this.view.advanced = prev.advanced;
      this.view.fontQuery = prev.fontQuery;
      this.view.notice = "";
      this.view.returnTo = undefined;
      this.view.selected = Math.min(
        prev.selected,
        Math.max(0, this.count() - 1),
      );
      return;
    }
    const fallback =
      this.view.returnTo ??
      (["history", "manage", "oneshot"].includes(this.view.screen)
        ? "account"
        : "home");
    this.navigate(fallback);
    if (fallback === "home") this.navStack.length = 0;
  }
  home() {
    this.navigate("home");
    this.render();
  }
  private async action(fn: () => unknown | Promise<unknown>) {
    this.view.busy = true;
    const indicator = setTimeout(() => {
      this.view.processing = true;
      if (!this.view.form) this.render();
    }, 120);
    try {
      await fn();
    } catch (e) {
      this.view.notice =
        e instanceof UserError
          ? localizeBackendText(safeText(e.message, 240), this.lang)
          : tr(
              this.lang,
              "操作失败，请检查设置。",
              "Operation failed; please check settings.",
            );
    } finally {
      clearTimeout(indicator);
      this.view.busy = false;
      this.view.processing = false;
      this.render();
    }
  }
  ask(
    title: string,
    label: string,
    value = "",
    secret = false,
    hint?: string,
  ): Promise<string> {
    this.view.form = { title, label, value, secret, hint };
    this.render();
    return new Promise((resolvePrompt, reject) => {
      this.prompt = { value, resolve: resolvePrompt, reject };
    });
  }
  async confirm(title: string, label: string) {
    if (
      (
        await this.ask(
          title,
          label,
          "",
          false,
          tr(
            this.lang,
            "输入 y 后 Enter 继续；Esc 取消",
            "Type y then Enter to confirm · Esc Cancel",
          ),
        )
      ).toLowerCase() !== "y"
    )
      throw new UserError(tr(this.lang, "已取消。", "Cancelled."));
  }
  current(): AccountView {
    if (!this.view.accountId)
      throw new UserError(
        tr(this.lang, "先选择一个账号。", "Select an account first."),
      );
    return this.account(this.view.accountId);
  }
  private async moreAction(index: number) {
    switch (moreActions[index]?.[0]) {
      case "a":
        return this.accounts.add();
      case "i":
        this.current();
        return this.showInformation();
      case "m":
        this.current();
        return this.navigate("manage");
      case "l":
        return this.navigate("libraries");
      case "r":
        return this.showSchool();
      case "u":
        this.navigate("appearance");
        return;
      case "n":
        return this.showNotices();
      case "g":
        return this.navigate("settings");
    }
  }
  private async toggleNotifications() {
    const enabled = this.app.state.settings.notifications === false;
    await this.app.commands.configureSettings({ notifications: enabled });
    this.view.notice = enabled
      ? tr(
          this.lang,
          "完成与异常通知：已开启（后台任务完成或异常时发送系统通知）。",
          "System notifications enabled for task completion & alerts.",
        )
      : tr(
          this.lang,
          "完成与异常通知：已关闭。",
          "System notifications disabled.",
        );
  }
  private async stepSetting(direction: number) {
    const s = this.app.state.settings;
    if (this.view.selected === 1) {
      const cur = Number.isInteger(s.maxConcurrent) && s.maxConcurrent >= 1 && s.maxConcurrent <= 16 ? s.maxConcurrent : 2;
      const next = ((cur - 1 + direction + 16) % 16) + 1;
      await this.app.commands.configureSettings({ maxConcurrent: next });
      this.view.notice =
        this.lang === "en"
          ? `Max concurrency set to ${next}.`
          : `并发上限已设为 ${next}。`;
      return;
    }
    if (this.view.selected === 4) {
      return this.toggleNotifications();
    }
    if (this.view.selected === 5) {
      const cur = s.termTarget ?? 0;
      const next = Math.max(0, Math.min(300, cur + direction * 5));
      await this.app.commands.configureSettings({ termTarget: next });
      this.view.notice =
        next > 0
          ? this.lang === "en"
            ? `Semester target set to ${next} runs.`
            : `学期目标已设为 ${next} 次。`
          : tr(this.lang, "已清除学期目标次数。", "Semester target cleared.");
    }
  }
  private async togglePrivacy() {
    const next = !this.app.state.settings.privacyMode;
    await this.app.commands.configureAppearance({ privacyMode: next });
    this.view.notice = next
      ? tr(this.lang, "隐私模式已开启。", "Privacy mask enabled.")
      : tr(this.lang, "隐私模式已关闭。", "Privacy mask disabled.");
  }
  private async toggleLanguage() {
    const next = this.lang === "en" ? "zh" : "en";
    await this.app.commands.configureAppearance({ language: next });
    this.view.notice =
      next === "en" ? "Switched to English UI." : "已切换为中文界面。";
  }
  private async nextColorTheme() {
    const current = resolveTheme(this.app.state.settings.colorTheme),
      next =
        colorThemes[(colorThemes.indexOf(current) + 1) % colorThemes.length]!;
    await this.app.commands.setColorTheme(next);
  }
  private async changeAppearance(direction: number) {
    const s = this.app.state.settings;
    const next = <T>(values: readonly T[], current: T) =>
      values[
        (values.indexOf(current) + direction + values.length) % values.length
      ]!;
    if (this.view.selected === 0)
      return this.app.commands.setColorTheme(
        next(colorThemes, resolveTheme(s.colorTheme)),
      );
    if (this.view.selected === 1)
      return this.app.commands.configureAppearance({
        logoFont: next(
          Object.keys(fontNames) as LogoFont[],
          resolveFont(s.logoFont),
        ),
      });
    if (this.view.selected === 2)
      return this.app.commands.configureAppearance({
        visualStyle: next(
          Object.keys(visualNames) as VisualStyle[],
          resolveVisual(s.visualStyle),
        ),
      });
    if (this.view.selected === 3)
      return this.app.commands.configureAppearance({
        visualOpacity: next(
          visualOpacities,
          resolveVisualOpacity(s.visualOpacity),
        ),
      });
    if (this.view.selected === 4)
      return this.app.commands.configureAppearance({
        gradientSpeed: next(
          gradientSpeeds as readonly number[],
          resolveGradientSpeed(s.gradientSpeed),
        ),
      });
    if (this.view.selected === 5)
      return this.app.commands.configureAppearance({
        animationFps: next(animationRates, resolveAnimationFps(s.animationFps)),
      });
    if (this.view.selected === 6) {
      if (!this.motion) {
        this.view.notice = tr(
          this.lang,
          "动画已通过启动参数关闭。",
          "Motion is locked off by CLI flag.",
        );
        return;
      }
      return this.app.commands.configureAppearance({
        motion: s.motion === false,
      });
    }
    return this.app.commands.configureAppearance({
      language: next(languages, resolveLanguage(s.language)),
    });
  }
  private async showSchool() {
    const accounts = this.app.state.accounts;
    const a =
      (this.view.screen === "menu"
        ? accounts.find((a) => a.id === this.view.accountId)
        : accounts[this.view.selected]) ??
      accounts.find((a) => a.session && a.session.status !== "invalid");
    this.navigate("school");
    this.view.infoTab = 0;
    this.view.accountId = a?.id;
  }
  private async showNotices() {
    const accounts = this.app.state.accounts;
    const a =
      (this.view.screen === "menu"
        ? accounts.find((a) => a.id === this.view.accountId)
        : accounts[this.view.selected]) ??
      accounts.find((a) => a.session && a.session.status !== "invalid") ??
      accounts[0];
    this.navigate("notices");
    this.view.accountId = a?.id;
  }
  async showInformation(_returnTo?: "home" | "account") {
    this.navigate("information");
    this.view.infoTab = 0;
  }
  private async schoolSettings() {
    const s = this.app.state.settings;
    const lang = this.lang;
    const school = await this.accounts.chooseSchool(Boolean(s.schoolName || this.app.state.accounts[0]?.school.name));
    const proxy = await this.ask(
      tr(lang, "学校公共检查代理", "PUBLIC PROBE PROXY"),
      tr(lang, "留空直连", "Blank for direct connection"),
      s.schoolProxy ?? "",
      Boolean(s.privacyMode),
    );
    await this.app.commands.configureSchool(school, proxy);
    const name = lang === "en" ? school.nameEn || school.name : school.name;
    this.view.notice = tr(
      lang,
      `已设为「${name}」（ID ${school.id}）。`,
      `Campus set to ${name} (ID ${school.id}).`,
    );
  }
  private async checkSchool() {
    if (!this.app.state.settings.schoolId) await this.schoolSettings();
    await this.app.commands.checkSchool();
    const rawNote =
      this.app.state.settings.compatibility?.note ??
      tr(this.lang, "尚未检查", "Unchecked");
    this.view.notice = localizeBackendText(rawNote, this.lang);
  }
  private async exportBackupFlow() {
    const lang = this.lang;
    const defaultPath = `cgscaline-backup-${new Date().toISOString().slice(0, 10)}.cgsbak`;
    const filePath = await this.ask(
      tr(lang, "导出加密备份包", "EXPORT ENCRYPTED VAULT"),
      tr(
        lang,
        "保存路径（单文件 AES-256-GCM 加密）",
        "Output path (single AES-256-GCM .cgsbak file)",
      ),
      defaultPath,
    );
    if (!filePath)
      throw new UserError(
        tr(lang, "保存路径不能为空。", "Output path cannot be empty."),
      );
    let pass1 = await this.ask(
      tr(lang, "备份口令", "VAULT PASSPHRASE"),
      tr(
        lang,
        "设置加密口令（至少 8 位，切勿遗忘）",
        "Set passphrase (8+ chars, do not lose)",
      ),
      "",
      true,
    );
    let pass2 = "";
    try {
      if (pass1.length < 8)
        throw new UserError(
          tr(
            lang,
            "备份口令至少需要 8 个字符。",
            "Passphrase requires at least 8 characters.",
          ),
        );
      pass2 = await this.ask(
        tr(lang, "确认备份口令", "CONFIRM PASSPHRASE"),
        tr(lang, "再次输入加密口令", "Re-enter passphrase"),
        "",
        true,
      );
      if (pass1 !== pass2)
        throw new UserError(
          tr(lang, "两次输入的口令不一致。", "Passphrases do not match."),
        );
      const withSessions = (
        await this.ask(
          tr(lang, "会话迁移", "SESSION MIGRATION"),
          tr(
            lang,
            "是否包含登录会话以跨机免重登？（y 包含 / n 仅导出配置与记录库）",
            "Include active session tokens for seamless migration? (y / n)",
          ),
          "y",
        )
      ).toLowerCase();
      const includeSessions = withSessions === "y" || withSessions === "yes";
      const res = await this.app.commands.exportBackup(
        filePath,
        pass1,
        includeSessions,
      );
      this.view.notice =
        lang === "en"
          ? `Exported vault (${res.accounts} accounts · ${res.libraries} libraries · ${res.path}).`
          : `已导出备份（${res.accounts} 个账号 · ${res.libraries} 个记录库 · ${res.path}）。`;
    } finally {
      pass1 = "";
      pass2 = "";
    }
  }
  private async importBackupFlow() {
    const lang = this.lang;
    const filePath = await this.ask(
      tr(lang, "导入加密备份包", "IMPORT ENCRYPTED VAULT"),
      tr(lang, "备份包文件路径（.cgsbak）", "Vault file path (.cgsbak)"),
    );
    if (!filePath)
      throw new UserError(
        tr(lang, "文件路径不能为空。", "File path cannot be empty."),
      );
    let passphrase = await this.ask(
      tr(lang, "备份口令", "VAULT PASSPHRASE"),
      tr(lang, "输入备份包解密口令", "Enter decryption passphrase"),
      "",
      true,
    );
    try {
      const res = await this.app.commands.importBackup(filePath, passphrase);
      this.view.notice =
        lang === "en"
          ? `Imported: +${res.accountsAdded} accounts (updated ${res.accountsUpdated}) · +${res.librariesAdded} libraries.`
          : `导入完成：新增账号 ${res.accountsAdded}（更新 ${res.accountsUpdated}）· 新增记录库 ${res.librariesAdded}。`;
    } finally {
      passphrase = "";
    }
  }
  async quit() {
    const active = this.app.state.tasks.filter(
      (t) => activeTask(t) && ["queued", "waiting"].includes(t.phase),
    ).length;
    if (active && !this.app.background)
      await this.confirm(
        "EXIT",
        this.lang === "en"
          ? `Exit and pause ${active} active task(s)?`
          : `退出并暂停 ${active} 个任务？`,
      );
    await this.close();
  }
  /** EOF/signals cannot answer an interactive confirmation. */
  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(async () => {
      if (this.prompt) {
        this.prompt.reject(
          new UserError(tr(this.lang, "已取消。", "Cancelled.")),
        );
        this.prompt = undefined;
        this.view.form = undefined;
      }
      try {
        await this.app.close();
      } finally {
        this.closed = true;
        this.tasks.dispose();
        this.unsubscribe?.();
        this.emit("close");
        this.render();
      }
    }));
  }
}
