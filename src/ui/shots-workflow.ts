import type { AccountView } from "../app/contracts.js";
import { resolveLanguage, tr } from "../core/i18n.js";
import { canUseLibrary as canUse, UserError, type OneShotTargets } from "../core/model.js";
import { maskText } from "../core/privacy.js";
import { durationText } from "../track/fit.js";
import { parseStart, termPlanSummary } from "../runtime/scheduling.js";
import { taskSummary, visibleTasks } from "./task-view.js";
import { clock } from "../render/theme.js";

import type { UIController } from "./controller.js";
export class OneShotWorkflow {
  constructor(private ui: UIController) {}

  private get lang() {
    return resolveLanguage(this.ui.app.state.settings.language);
  }

  async oneShot(a: AccountView) {
    await this.ui.app.commands.assertSession(a.id);
    if (!this.ui.app.state.libraries.some((l) => canUse(l, a))) {
      this.ui.navigate("libraries");
      this.ui.view.accountId = a.id;
      this.ui.view.notice = tr(
        this.lang,
        "请先导入运动记录：按回车或 I 选择 .db/.bak/.zip 文件，或按 P 连接手机读取。",
        "Import workout data first: press Enter/I for .db/.bak/.zip file, or P for ADB phone pull.",
      );
      return;
    }
    const p = await this.ui.app.commands.prepareDefault(a.id);
    this.ui.navigate("oneshot");
    this.ui.view.accountId = a.id;
    this.ui.view.preview = p;
    this.ui.view.returnTo = "account";
  }

  async refreshOneShot(targets?: OneShotTargets) {
    const current = this.ui.view.preview;
    if (!current) return;
    const next = await this.ui.app.commands.prepareDefault(
      this.ui.current().id,
      {
        ...(targets ?? current.targets ?? {}),
        avoidRunId: current.sourceRunId,
        avoidSeed: current.seed,
      },
    );
    this.ui.view.preview = next;
    this.ui.view.selected = 0;
    this.ui.view.notice = "";
  }

  async startPreview() {
    const p = this.ui.view.preview;
    if (!p) return;
    const lang = this.lang;
    const a = this.ui.current(),
      priv = !!this.ui.app.state.settings.privacyMode;
    const u = priv ? maskText(a.username) : a.username;
    await this.ui.confirm(
      tr(lang, "开始一次", "START ONE-SHOT"),
      lang === "en"
        ? `${u} · Route ${p.routeId} · ${p.body.odometer} km · ${durationText(p.durationSec)}. Launch now?`
        : `${u} · 路线 ${p.routeId} · ${p.body.odometer} km · ${durationText(p.durationSec)}。现在开始？`,
    );
    const task = await this.ui.app.commands.start(a.id, p);
    this.ui.openTop("tasks");
    this.ui.view.selected = visibleTasks(this.ui.app.state).findIndex(
      (t) => t.id === task.id,
    );
    this.ui.view.notice = taskSummary(task, undefined, lang);
  }

  async schedulePreview() {
    const p = this.ui.view.preview;
    if (!p) return;
    const lang = this.lang;
    const a = this.ui.current();
    const advice = termPlanSummary(a, this.ui.app.state.settings.termTarget, Date.now(), lang);
    const basePrompt = tr(
      lang,
      "现在 / +10 / 21:30 / 17:20-18:10 / 智能",
      "now / +10 / 21:30 / 17:20-18:10 / auto",
    );
    const label = advice ? `${basePrompt} (${advice.line})` : basePrompt;
    const when = parseStart(
      (await this.ui.ask(tr(lang, "开始时间", "START WINDOW"), label, "+10")).replace(
        /\s*(?:分钟|min)$/i,
        "",
      ),
    );
    const u = this.ui.app.state.settings.privacyMode ? maskText(a.username) : a.username;
    await this.ui.confirm(
      tr(lang, "定时执行", "ARM SCHEDULE"),
      lang === "en"
        ? `${u} · ${p.body.odometer} km · ${durationText(p.durationSec)} · ${clock(when)}. Enqueue?`
        : `${u} · ${p.body.odometer} km · ${durationText(p.durationSec)} · ${clock(when)}。确认加入计划？`,
    );
    const task = await this.ui.app.commands.queuePrepared(
      a.id,
      p,
      Math.max(when, Date.now()),
    );
    this.ui.openTop("tasks");
    this.ui.view.selected = visibleTasks(this.ui.app.state).findIndex(
      (t) => t.id === task.id,
    );
    this.ui.view.notice = taskSummary(task, undefined, lang);
  }

  async plan() {
    const lang = this.lang;
    const accounts = this.ui.app.state.accounts;
    const ids = this.ui.view.marked?.length
      ? this.ui.view.marked
      : accounts[this.ui.view.selected]
        ? [accounts[this.ui.view.selected]!.id]
        : [];
    if (!ids.length)
      throw new UserError(tr(lang, "先选择一个账号，或用 Space 勾选多个账号。", "Select an account or mark multiple with Space."));
    const sample = ids.length === 1 ? this.ui.account(ids[0]!) : undefined;
    const advice = termPlanSummary(sample, this.ui.app.state.settings.termTarget, Date.now(), lang);
    const when = await this.ui.ask(
      tr(lang, "执行计划", "BATCH SCHEDULE"),
      lang === "en"
        ? `First start time (now / +10 / 21:30 / 17:20-18:10 / auto)${advice ? ` · ${advice.line}` : ""}`
        : `第一个账号何时开始（现在 / +10 / 21:30 / 17:20-18:10 / 智能）${advice ? ` · ${advice.line}` : ""}`,
      lang === "en" ? "now" : "现在",
    );
    const first = parseStart(when.replace(/\s*(?:分钟|min)$/i, ""));
    const gap = Number(
      await this.ui.ask(
        tr(lang, "错峰间隔", "STAGGER INTERVAL"),
        tr(lang, "每个账号错开几分钟（0 表示同时开始）", "Minutes between accounts (0 for simultaneous)"),
        ids.length > 1 ? "5" : "0",
      ),
    );
    if (!Number.isFinite(gap) || gap < 0 || gap > 1440)
      throw new UserError(tr(lang, "间隔需为 0–1440 分钟。", "Interval must be 0–1440 minutes."));
    this.ui.navigate("records");
    this.ui.view.title = tr(lang, "计划预览", "SCHEDULE PREVIEW");
    this.ui.view.returnTo = "home";
    const priv = !!this.ui.app.state.settings.privacyMode;
    this.ui.view.lines = ids.map(
      (id, i) => {
        const u = this.ui.account(id).username;
        return lang === "en"
          ? `${priv ? maskText(u) : u} · Route ${this.ui.account(id).routeId} · Earliest ${clock(first + i * gap * 60_000)}`
          : `${priv ? maskText(u) : u} · 路线 ${this.ui.account(id).routeId} · 最早开始 ${clock(first + i * gap * 60_000)}`;
      },
    );
    try {
      await this.ui.confirm(
        tr(lang, "确认执行计划", "CONFIRM SCHEDULE"),
        lang === "en"
          ? `${ids.length} account(s) · stagger ${gap} min · max concurrency ${this.ui.app.state.settings.maxConcurrent}. Enqueue?`
          : `${ids.length} 个账号 · 间隔 ${gap} 分钟 · 并发上限 ${this.ui.app.state.settings.maxConcurrent}。确认加入计划？`,
      );
    } catch (e) {
      this.ui.home();
      throw e;
    }
    await this.ui.app.commands.queuePlan(
      ids,
      Math.max(first, Date.now()),
      gap * 60_000,
    );
    this.ui.view.marked = [];
    this.ui.openTop("tasks");
    this.ui.view.notice = tr(lang, "计划已保存。", "Schedule armed.");
  }
}
