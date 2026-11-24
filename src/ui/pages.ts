import { activityText, recentActivity } from "../core/activity.js";
import { resolveAnimationFps, resolveVisualOpacity } from "../render/appearance.js";
import {
  accents,
  resolveFont,
  resolveTheme,
  resolveVisual,
  themeNames,
} from "../render/chroma.js";
import { deviceConflicts } from "../core/device-identity.js";
import { fontLabel, languageNames, resolveLanguage, tr, visualStyleLabel } from "../core/i18n.js";
import {
  dateTime,
  cachedInformation,
  informationLines,
  informationSummary,
  reasonLabel,
  schoolLines,
} from "./information-view.js";
import { filterFonts, logoFonts, resolveGradientSpeed } from "../render/logo-fonts.js";
import { maskFixed, maskProxyLabel, maskText } from "../core/privacy.js";
import { oneShotLines } from "./oneshot-view.js";
import { termPlanSummary } from "../runtime/scheduling.js";
import { DEFAULT_SCHOOL_PROFILE } from "../campus/school-profile.js";
import {
  recordStatus,
  taskAccountLabel,
  taskSummary,
  visibleTasks,
} from "./task-view.js";

import type { AccountView, AppState } from "../app/contracts.js";
import {
  getAccountActions,
  getAppearanceActions,
  getManageActions,
  getMoreActions,
  getSettingActions,
  networkLabel,
} from "./actions.js";
import { cells, clip, clock, pad, phaseLabel, sessionLabel, shortDateTime, wrap } from "./text.js";
import type { RenderView } from "./view.js";

export interface PageContext {
  state: AppState;
  view: RenderView;
  width: number;
  height: number;
  inner: number;
  leftWidth: number;
  theme: ReturnType<typeof resolveTheme>;
  font: ReturnType<typeof resolveFont>;
  visual: ReturnType<typeof resolveVisual>;
  colors: ReturnType<typeof accents>;
  a?: AccountView;
  fg: (s: string, rgb: number[]) => string;
  ink: (s: string) => string;
  dim: (s: string) => string;
  pink: (s: string) => string;
  cyan: (s: string) => string;
  lime: (s: string) => string;
  ext: (v: unknown) => string;
}

export function resolveCampusLabel(
  state: AppState,
  lang = resolveLanguage(state.settings.language),
  focusedAccount?: AccountView,
): string {
  const acctSchool = focusedAccount?.school ?? state.accounts[0]?.school;
  if (lang === "en") {
    return acctSchool?.nameEn || acctSchool?.name || state.settings.schoolNameEn || state.settings.schoolName || DEFAULT_SCHOOL_PROFILE.nameEn;
  }
  return acctSchool?.name || state.settings.schoolName || DEFAULT_SCHOOL_PROFILE.name;
}

export function pageContent({
  state,
  view,
  width,
  height,
  inner,
  leftWidth,
  theme,
  font,
  visual,
  colors,
  a,
  fg,
  ink,
  dim,
  pink,
  cyan,
  lime,
  ext,
}: PageContext) {
  const body: string[] = [];
  const lang = resolveLanguage(state.settings.language);
  const en = lang === "en";
  const campus = resolveCampusLabel(state, lang);
  const privacy = !!state.settings.privacyMode;
  const pText = (v: string) => (privacy ? maskText(v) : v);
  const nowMs = Date.now();
  const waitingPct = (t: AppState["tasks"][number]) => {
    if (t.phase !== "waiting" || !t.session) return "";
    const span = Math.max(1000, t.session.endAtMs - t.session.startAtMs);
    const end =
      t.session.commitAtLocalMs ??
      t.session.endAtMs - (t.session.clockOffsetMs ?? 0);
    const start = end - span;
    return ` ${Math.max(0, Math.min(100, Math.round(((nowMs - start) / span) * 100)))}%`;
  };
  let selectedRow = 0,
    anchor = 2;
  const line = (s = "") => body.push(s);
  const ellipsis = (s: string, maxCols: number) =>
    cells(s) <= maxCols ? s : clip(s, Math.max(1, maxCols - 1)) + "…";
  const title = (s: string) => {
    line(cyan(s));
    line();
  };
  const choice = (s: string, i: number) => {
    if (i === view.selected) selectedRow = body.length;
    line(
      i === view.selected
        ? pink("❯ ") + lime(pad(ext(s), leftWidth - 2))
        : "  " + ink(clip(ext(s), leftWidth - 2)),
    );
  };
  if (view.screen === "home") {
    title(
      en
        ? `ACCOUNTS${view.marked?.length ? ` · ${view.marked.length} MARKED` : ""}`
        : `账号${view.marked?.length ? ` · 已选 ${view.marked.length}` : ""}`,
    );
    const table = leftWidth >= 48,
      markerWidth = view.marked?.length ? 4 : 0,
      distinctSchools = new Set(state.accounts.map((x) => x.school.baseUrl)).size,
      showSchoolCol =
        table &&
        leftWidth >= 64 &&
        (distinctSchools > 1 || (leftWidth >= 72 && state.accounts.some((x) => Boolean(x.school.name)))),
      schoolColWidth = showSchoolCol ? 12 : 0,
      schoolGap = showSchoolCol ? 1 : 0,
      nicknameWidth = Math.max(
        6,
        Math.min(14, leftWidth - 43 - markerWidth - schoolColWidth - schoolGap),
      );
    if (table && height >= 18)
      line(
        dim(
          "  " +
            "".padEnd(markerWidth) +
            (showSchoolCol ? pad(tr(lang, "学校", "CAMPUS"), schoolColWidth) + " " : "") +
            pad(tr(lang, "昵称", "ALIAS"), nicknameWidth) +
            " " +
            pad(tr(lang, "学号", "USER ID"), 16) +
            " " +
            pad(tr(lang, "路线", "ROUTE"), 5) +
            " " +
            tr(lang, "状态", "STATUS"),
        ),
      );
    state.accounts.forEach((a, i) => {
      const t = state.tasks.find(
        (t) => t.accountId === a.id && !["done", "abandoned"].includes(t.phase),
      );
      const baseDetail = (a.deviceConflict ?? (deviceConflicts(a, state.accounts).length > 0))
        ? tr(lang, "设备标识冲突", "ID Conflict")
        : t
          ? `${phaseLabel(t, lang)}${t.phase === "queued" ? ` ${clock(t.plannedStartAt ?? 0)}` : waitingPct(t)}`
          : sessionLabel(a, lang);
      const proxyTag = a.proxy ? (en ? " · Proxy" : " · 代理") : "";
      const detail = `${baseDetail}${proxyTag}`;
      const marked = view.marked?.length
        ? view.marked.includes(a.id)
          ? "[✓] "
          : "[ ] "
        : "";
      const schoolCell = showSchoolCol
        ? (() => {
            const raw = en
              ? a.school.code || a.school.nameEn || a.school.name || a.school.id || "—"
              : a.school.name || a.school.code || a.school.id || "—";
            return pad(ellipsis(ext(privacy ? maskText(raw) : raw), schoolColWidth), schoolColWidth) + " ";
          })()
        : "";
      choice(
        table
          ? `${marked}${schoolCell}${pad(ext(pText(a.label)), nicknameWidth)} ${pad(ext(pText(a.username)), 16)} ${pad(ext(a.routeId), 5)} ${detail}`
          : `${marked}${pad(ext(pText(a.username)), 16)} ${ext(pText(a.label))}`,
        i,
      );
    });
    choice(tr(lang, "+ 添加账号", "+ Add Account"), state.accounts.length);
    line();
    const activeCnt = state.tasks.filter((t) =>
      ["starting", "waiting", "committing"].includes(t.phase),
    ).length;
    const queuedCnt = state.tasks.filter((t) => t.phase === "queued").length;
    line(
      en
        ? `${cyan(`ACTIVE ${activeCnt}/${state.settings.maxConcurrent}`)}  ${dim(`QUEUED ${queuedCnt}`)}${view.background ? "  " + (view.connected === false ? pink("DAEMON LOST") : dim("DAEMON ONLINE")) : ""}`
        : `${cyan(`运行 ${activeCnt}/${state.settings.maxConcurrent}`)}  ${dim(`计划 ${queuedCnt}`)}${view.background ? "  " + (view.connected === false ? pink("后台断开") : dim("后台在线")) : ""}`,
    );
    for (const t of state.tasks
      .filter((t) => ["waiting", "queued", "review"].includes(t.phase))
      .slice(0, 3)) {
      const at =
        t.phase === "queued"
          ? t.plannedStartAt
          : (t.session?.commitAtLocalMs ?? t.session?.endAtMs);
      line(
        dim(
          `${ext(taskAccountLabel(t, state, privacy))} · ${phaseLabel(t, lang)}${waitingPct(t)}${at ? ` ${clock(at)}` : ""}`,
        ),
      );
    }
    const current = state.accounts[view.selected];
    if (current) {
      const info = cachedInformation(current),
        stats = info?.statistics.data,
        plan = termPlanSummary(current, state.settings.termTarget, nowMs, lang);
      if (stats || info?.totals.data?.length || plan) {
        line();
        line(cyan(`${ext(pText(current.label))} · ${tr(lang, "本学期", "CURRENT TERM")}`));
        if (stats) {
          line(ink(en ? `Valid Runs   ${stats.count}` : `有效锻炼  ${stats.count} 次`));
          line(dim(en ? `Monthly Avg  ${stats.monthlyDistance || "—"} km` : `月均里程  ${stats.monthlyDistance || "—"} km`));
          if (stats.monthlyTime)
            line(dim(en ? `Monthly Time ${stats.monthlyTime}` : `月均时长  ${stats.monthlyTime}`));
        } else
          info?.totals.data
            ?.slice(0, 2)
            .forEach((v) =>
              line(dim(`${ext(v.label)}  ${ext(v.value)} ${ext(v.unit)}`)),
            );
        if (plan && (state.settings.termTarget || plan.daysLeft !== undefined))
          line(dim(ext(plan.line)));
      }
      const latestNotice = info?.notices?.data?.[0];
      if (latestNotice) {
        line();
        line(cyan(tr(lang, "学校通知", "CAMPUS BULLETIN")));
        const urgentTag = latestNotice.forced ? tr(lang, "[重要] ", "[URGENT] ") : "";
        line(
          (urgentTag ? pink(urgentTag) : "") +
            ink(
              ellipsis(
                ext(latestNotice.title),
                Math.max(12, leftWidth - (urgentTag ? cellsWidthHint(urgentTag) : 2)),
              ),
            ),
        );
      }
    }
    if (!view.form && height >= 24) {
      const personal = current
        ? recentActivity(state, current.id, 20).filter(
            (v) => v.accountId === current.id && v.code !== "request",
          )
        : [];
      const events = (
        personal.length ? personal : recentActivity(state, undefined, 4)
      ).slice(0, 4);
      if (events.length) {
        line();
        line(cyan(tr(lang, "最近动态", "ACTIVITY STREAM")));
        for (const event of events) {
          const tint =
            event.level === "error"
              ? colors.error
              : event.level === "warn"
                ? colors.warning
                : event.level === "ok"
                  ? colors.success
                  : colors.muted;
          const owner =
            !current && event.accountId
              ? state.accounts.find((a) => a.id === event.accountId)
              : undefined;
          line(
            dim(clock(event.at)) +
              "  " +
              fg(
                clip(
                  (owner ? ext(pText(owner.username)) + " " : "") +
                    activityText(event, lang),
                  leftWidth - 10,
                ),
                tint,
              ),
          );
        }
      }
    }
  } else if (view.screen === "menu") {
    title(tr(lang, "更多", "MORE"));
    getMoreActions(lang).forEach(([, label], i) => choice(label, i));
  } else if (view.screen === "account" && a) {
    title(`${ext(pText(a.username))} · ${ext(pText(a.label))}`);
    line(
      dim(
        en
          ? `Route ${a.routeId} · ${a.sourceMode === "private" ? "Private Vault" : "Shared Pool"} · ${sessionLabel(a, "en")}`
          : `路线 ${a.routeId} · ${a.sourceMode === "private" ? "私人记录" : "本机共享记录"} · ${sessionLabel(a)}`,
      ),
    );
    line(dim(networkLabel(a, privacy, lang)));
    informationSummary(a, state.settings.termTarget, lang).forEach((s) => line(dim(ext(s))));
    line();
    const conflict = a.deviceConflict ?? (deviceConflicts(a, state.accounts).length > 0);
    getAccountActions(lang).forEach((s, i) =>
      choice(
        i === 0 && conflict
          ? tr(lang, "处理设备标识冲突", "Resolve Device ID Conflict")
          : i === 0 && (!a.session || a.session.status === "invalid")
            ? tr(lang, "登录一次", "Sign In Once")
            : s,
        i,
      ),
    );
  } else if (view.screen === "manage" && a) {
    title(`${tr(lang, "账号设置", "ACCOUNT SETTINGS")} · ${ext(pText(a.username))}`);
    const acctCampus = en ? a.school.nameEn || a.school.name : a.school.name;
    if (acctCampus || a.school.id) {
      const shownCampus = acctCampus ? (privacy ? maskText(acctCampus) : ext(acctCampus)) : "—";
      const shownId = a.school.id ? (privacy ? maskText(a.school.id) : ext(a.school.id)) : "—";
      line(dim(`${tr(lang, "学校", "Campus")} ${shownCampus} · ID ${shownId}`));
    }
    const limits = cachedInformation(a)?.deviceLimits?.data;
    const unknown = tr(lang, "未知", "unknown");
    const sources = { tui: tr(lang, "TUI 固定", "TUI assigned"), manual: tr(lang, "手动设置", "Manual"),
      portable: tr(lang, "便携备份", "Portable backup"), existing: tr(lang, "原有档案", "Existing profile"),
      phone: tr(lang, "真机同步", "Phone backup") };
    line(dim(sources[a.deviceSource ?? "existing"]));
    line(dim(tr(lang, "每账号设备上限", "Devices/account") + " " + (limits?.devicesPerAccount ?? unknown) +
      " · " + tr(lang, "每设备账号上限", "Accounts/device") + " " + (limits?.accountsPerDevice ?? unknown) +
      (limits ? " · " + dateTime(limits.readAt) : "")));
    line(
      dim(
        `${ext(a.device.manufacturer)} ${ext(a.device.model)} · Android ${ext(a.device.androidRelease)} / SDK ${ext(a.device.sdk)}`,
      ),
    );
    line(
      dim(`Build ${ext(a.device.buildId)} · App ${ext(a.device.appVersion)}`),
    );
    line(dim(networkLabel(a, privacy, lang)));
    line();
    getManageActions(lang).forEach(choice);
  } else if (view.screen === "oneshot") {
    title(`ONE-SHOT / PREVIEW${a ? ` · ${ext(pText(a.username))}` : ""}`);
    anchor = 4;
    (view.preview ? oneShotLines(view.preview, lang) : [tr(lang, "暂无预览", "No preview ready")]).forEach((s, i) => {
      if (i === view.selected) selectedRow = body.length;
      wrap(ext(s), leftWidth).forEach((v) => line(i === 0 ? lime(v) : ink(v)));
    });
  } else if (view.screen === "information" && a) {
    line(cyan(`${tr(lang, "账号概览", "ACCOUNT OVERVIEW")} · ${ext(pText(a.username))}`));
    const info = cachedInformation(a);
    line(
      info?.fetchedAt
        ? dim(
            `${tr(lang, "缓存", "Cached")} ${new Date(info.fetchedAt).toLocaleDateString(en ? "en-CA" : "zh-CN")} ${clock(info.fetchedAt)}`,
          )
        : "",
    );
    line();
    anchor = 4;
    informationLines(a, state.settings.termTarget, lang).forEach((s, i) => {
      if (i === view.selected) selectedRow = body.length;
      wrap(ext(s), inner).forEach((v) => line(ink(v)));
    });
  } else if (view.screen === "school") {
    line(cyan(`${tr(lang, "学校资料", "VENUE RULES")} · ${ext(pText(campus))}`));
    line(
      (en ? ["Routes", "Invalid Codes"] : ["路线", "无效原因"])
        .map((s, i) =>
          (i === (view.infoTab ?? 0) ? pink : dim)(`${i + 1} ${s}`),
        )
        .join("    "),
    );
    const info = a ? cachedInformation(a) : undefined;
    line(
      dim(
        `${tr(lang, "读取账号", "Account")} ${a ? ext(pText(a.username)) : tr(lang, "未选择", "None")}${info?.schoolFetchedAt ? ` · ${tr(lang, "缓存", "Cached")} ${new Date(info.schoolFetchedAt).toLocaleDateString(en ? "en-CA" : "zh-CN")} ${clock(info.schoolFetchedAt)}` : ""}`,
      ),
    );
    line();
    anchor = 4;
    (a ? schoolLines(a, view.infoTab, lang) : [tr(lang, "暂无账号", "No accounts")]).forEach((s, i) => {
      if (i === view.selected) selectedRow = body.length;
      wrap(ext(s), inner).forEach((v) => line(ink(v)));
    });
  } else if (view.screen === "notices") {
    line(cyan(`${tr(lang, "学校通知", "CAMPUS NOTICES")} · ${ext(pText(campus))}`));
    const info = a ? cachedInformation(a) : undefined;
    line(
      dim(
        `${tr(lang, "读取账号", "Account")} ${a ? ext(pText(a.username)) : tr(lang, "未选择", "None")}${info?.noticesFetchedAt ? ` · ${tr(lang, "缓存", "Cached")} ${new Date(info.noticesFetchedAt).toLocaleDateString(en ? "en-CA" : "zh-CN")} ${clock(info.noticesFetchedAt)}` : ""}`,
      ),
    );
    line();
    anchor = 3;
    if (!a) {
      line(dim(tr(lang, "暂无账号", "No accounts")));
    } else if (!info?.noticesFetchedAt) {
      line(dim(tr(lang, "暂无学校通知缓存，按 R 刷新", "No notices cached · press R to refresh")));
    } else if (info.notices?.error) {
      line(dim(ext(info.notices.error)));
    } else if (!info.notices?.data?.length) {
      line(dim(tr(lang, "暂无学校发布的通知", "No active campus notices")));
    } else {
      info.notices.data.forEach((n, i) => {
        const prefix = n.forced ? tr(lang, "[重要] ", "[URGENT] ") : "";
        choice(ellipsis(`${prefix}${n.title}`, leftWidth - 2), i);
        const sub = [
          n.date?.slice(0, 10),
          n.remindWindow ? `${tr(lang, "提醒", "Window")} ${n.remindWindow}` : "",
          n.summary ? ellipsis(n.summary, 28) : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (sub) line(dim(`  ${ellipsis(ext(sub), leftWidth - 2)}`));
      });
    }
  } else if (view.screen === "appearance") {
    title(tr(lang, "外观", "APPEARANCE"));
    const labels = getAppearanceActions(lang);
    [
      themeNames[theme],
      fontLabel(font, lang),
      visualStyleLabel(visual, lang),
      `${resolveVisualOpacity(state.settings.visualOpacity)}%`,
      `${resolveGradientSpeed(state.settings.gradientSpeed)}×`,
      `${resolveAnimationFps(state.settings.animationFps)} FPS`,
      view.motionLocked
        ? tr(lang, "关闭（启动参数）", "Off (CLI Flag)")
        : state.settings.motion === false
          ? tr(lang, "关闭", "Off")
          : tr(lang, "开启", "On"),
      languageNames[lang],
    ].forEach((v, i) => choice(`${pad(labels[i]!, en ? 18 : 10)}${v}`, i));
  } else if (view.screen === "fonts") {
    const fonts = filterFonts(view.fontQuery);
    title(
      `${tr(lang, "字标", "WORDMARK")} ${fonts.length}/${logoFonts.length}${view.fontQuery ? ` · ${ext(view.fontQuery)}` : ""}`,
    );
    if (!fonts.length) line(dim(tr(lang, "没有匹配项", "No matching fonts")));
    fonts.forEach((key, i) =>
      choice(`${key === font ? "● " : ""}${fontLabel(key, lang)}`, i),
    );
  } else if (view.screen === "history") {
    title(`${tr(lang, "我的记录", "WORKOUT LOG")}${a ? ` · ${ext(pText(a.username))}` : ""}`);
    const isArchive = view.historyScope === "archive";
    line(
      en
        ? `${(isArchive ? dim : pink)("1 Current Term")}    ${(isArchive ? pink : dim)("2 Archive")}`
        : `${(isArchive ? dim : pink)("1 本学期")}    ${(isArchive ? pink : dim)("2 往期归档")}`,
    );
    if (view.historyFetchedAt)
      line(dim(`${tr(lang, "缓存", "Cached")} ${clock(view.historyFetchedAt)}`));
    const reasons = a ? cachedInformation(a)?.reasons.data : undefined;
    if (!view.history?.length)
      line(
        dim(
          view.historyFetchedAt
            ? tr(lang, "暂无记录", "No workouts found")
            : tr(lang, "暂无缓存", "No cache · press R to sync"),
        ),
      );
    view.history?.forEach((r, i) => {
      choice(`${r.beginTime}  ${r.odometer} km  ${recordStatus(r, lang)}`, i);
      const reason = reasonLabel(r.inValidReason, reasons);
      line(
        dim(
          `  ${tr(lang, "路线", "Route")} ${r.routeId}  ${r.activeTime}${reason ? `  ${ext(reason)}` : ""}`,
        ),
      );
    });
  } else if (view.screen === "tasks" || view.screen === "executions") {
    const history = view.screen === "executions",
      tasks = visibleTasks(state, history);
    title(
      history
        ? tr(lang, "执行记录", "EXECUTION LOG")
        : tr(lang, "执行计划", "TASK QUEUE"),
    );
    if (!tasks.length) line(dim(tr(lang, "暂无任务", "No tasks")));
    tasks.forEach((t, i) => {
      const at =
        t.phase === "queued"
          ? t.plannedStartAt
          : (t.session?.commitAtLocalMs ?? t.session?.endAtMs);
      choice(
        `${taskAccountLabel(t, state, privacy)} · ${phaseLabel(t, lang)}${waitingPct(t)}${at ? (history ? ` · ${shortDateTime(at)}` : ` · ${t.phase === "queued" ? tr(lang, "最早开始", "Start") : tr(lang, "提交", "Commit")} ${clock(at)}`) : ""}`,
        i,
      );
      line(dim(`  ${ext(taskSummary(t, view.taskChecks?.[t.id], lang))}`));
    });
    const selected = tasks[view.selected],
      check = selected && view.taskChecks?.[selected.id];
    const audit =
      check?.kind === "result"
        ? check.audit
        : check?.kind === "error"
          ? undefined
          : selected?.audit;
    if (history && audit) {
      line();
      line(
        dim(
          en
            ? `Verified ${clock(audit.checkedAt)}${audit.found ? "" : " · Not in remote list"}`
            : `更新 ${clock(audit.checkedAt)}${audit.found ? "" : " · 未查到记录"}`,
        ),
      );
    }
  } else if (view.screen === "libraries") {
    title(tr(lang, "记录库", "TRACK LIBRARIES"));
    state.libraries.forEach((l, i) => {
      const schoolNote = l.schoolName
        ? ` · ${privacy ? maskText(l.schoolName) : ext(l.schoolName)}`
        : "";
      choice(
        en
          ? `${l.label}${schoolNote} · ${l.scope === "private" ? "Private" : "Shared"} · ${l.runCount} runs · Routes ${l.routeIds.join("/")}`
          : `${l.label}${schoolNote} · ${l.scope === "private" ? "私人" : "共享"} · ${l.runCount} 条 · 路线 ${l.routeIds.join("/")}`,
        i,
      );
    });
    if (!state.libraries.length) {
      choice(tr(lang, "导入运动记录（支持 .db / 备份 .bak/.zip / 连接手机）", "Import Workout Data (.db / .bak / .zip / ADB Phone)"), 0);
      line();
      line(dim(tr(lang, "  I 选择本地数据库或备份文件（内置自动解密）", "  I  Import local encrypted DB, backup archive, or JSON")));
      line(dim(tr(lang, "  P 连接安卓手机读取（ADB 自动提取解密）", "  P  Read directly from connected Android phone via ADB")));
    }
  } else if (view.screen === "settings") {
    title(tr(lang, "设置", "GLOBAL SETTINGS"));
    const rawSchoolLabel = state.settings.schoolName || state.accounts[0]?.school.name || state.settings.schoolId || "";
    const schoolCodeVal = rawSchoolLabel
      ? privacy
        ? maskText(rawSchoolLabel)
        : ext(rawSchoolLabel)
      : tr(lang, "待选择", "Unset");
    const schoolNetVal = state.settings.schoolProxy
      ? privacy
        ? maskProxyLabel(state.settings.schoolProxy)
        : tr(lang, "代理", "Proxy")
      : tr(lang, "直连", "Direct");
    const settingValues = [
      `${schoolCodeVal} · ${schoolNetVal}`,
      `${state.settings.maxConcurrent}`,
      en ? `${state.libraries.length} loaded` : `${state.libraries.length} 个`,
      `${themeNames[theme]} · ${resolveAnimationFps(state.settings.animationFps)} FPS · ${languageNames[lang]}`,
      state.settings.notifications === false
        ? tr(lang, "关闭", "Off")
        : tr(lang, "开启", "On"),
      state.settings.termTarget
        ? en
          ? `${state.settings.termTarget} runs`
          : `${state.settings.termTarget} 次`
        : tr(lang, "未设", "Off"),
      "",
      "",
      "",
      "",
    ];
    getSettingActions(lang).forEach((label, i) => {
      const val = settingValues[i];
      choice(val ? `${pad(label, en ? 26 : 18)}${val}` : label, i);
    });
  } else {
    title(view.title ?? tr(lang, "详情", "DETAIL"));
    const textWidth = view.detailMinimap?.length ? leftWidth : inner;
    (view.lines ?? []).forEach((s, i) => {
      if (i === view.selected) selectedRow = body.length;
      wrap(ext(s), textWidth).forEach((v) => line(ink(v)));
    });
  }
  return { body, selectedRow, anchor };
}

function cellsWidthHint(tag: string): number {
  return tag.startsWith("[URGENT]") ? 10 : 8;
}
