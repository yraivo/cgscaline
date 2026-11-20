import { resolveVisualOpacity } from "../render/appearance.js";
import { APP_NAME, APP_VERSION } from "../core/brand.js";
import {
  CANVAS,
  accents,
  fontNames,
  gradient,
  gradientLine,
  minimapArtwork,
  resolveFont,
  resolveTheme,
  resolveVisual,
  visualRenderers,
  wordmark,
  type TaskPulse,
} from "../render/chroma.js";
import { fontLabel, resolveLanguage, tr } from "../core/i18n.js";
import { filterFonts, resolveGradientSpeed } from "../render/logo-fonts.js";
import { extractMinimap, type MinimapPoint } from "../render/minimap.js";
import { safeText } from "../core/model.js";
import { maskText } from "../core/privacy.js";
import { wordmarkRows } from "../render/wordmark.js";

import type { AppState } from "../app/contracts.js";
import { pageContent, resolveCampusLabel } from "./pages.js";
import { cells, clip, keyRows, pad, stripAnsi, wrap } from "./text.js";
import type { RenderView } from "./view.js";
import { workoutPageActions } from "./workout-pages.js";
import { taskPageActions } from "./task-pages.js";

const EDGE_LOGO_WIDTH = Math.max(...wordmarkRows.map((r) => r.length));

function activePulse(state: AppState, now = Date.now()): TaskPulse | undefined {
  const running = state.tasks.filter((t) =>
    ["starting", "waiting", "committing"].includes(t.phase),
  );
  if (!running.length) return undefined;
  if (running.some((t) => t.phase === "committing")) {
    return {
      progress: 1,
      countdownSec: 0,
      committing: true,
      activeCount: running.length,
    };
  }
  const waiting = running
    .filter((t) => t.phase === "waiting" && t.session)
    .sort(
      (x, y) =>
        (x.session!.commitAtLocalMs ?? x.session!.endAtMs) -
        (y.session!.commitAtLocalMs ?? y.session!.endAtMs),
    )[0];
  if (waiting?.session) {
    const span = Math.max(
      1000,
      waiting.session.endAtMs - waiting.session.startAtMs,
    );
    const end =
      waiting.session.commitAtLocalMs ??
      waiting.session.endAtMs - (waiting.session.clockOffsetMs ?? 0);
    const start = end - span;
    return {
      progress: Math.max(0, Math.min(1, (now - start) / span)),
      countdownSec: Math.max(0, (end - now) / 1000),
      activeCount: running.length,
    };
  }
  return { progress: 0.04, countdownSec: 120, activeCount: running.length };
}

function activeMinimap(view: RenderView): readonly MinimapPoint[] | undefined {
  if (view.screen === "oneshot" && view.preview) {
    if ("kind" in view.preview) return view.preview.minimap;
    return extractMinimap(view.preview.body.coordinate);
  }
  if (
    view.screen === "records" &&
    view.detailRecord &&
    view.detailMinimap?.length
  ) {
    return view.detailMinimap;
  }
  return undefined;
}

export interface Scene {
  width: number;
  height: number;
  header: string[];
  body: string[];
  form: string[];
  separator: string[];
  footer: string[];
}
export function buildScene(
  state: AppState,
  view: RenderView,
  width = 104,
  height = 34,
  color = true,
  demo = false,
): Scene {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const margin = width >= 60 ? 2 : 1,
    inner = Math.max(1, width - 1 - margin * 2),
    motion = view.motion ?? 0,
    bg = color ? CANVAS : "";
  const theme = resolveTheme(state.settings.colorTheme),
    colors = accents(theme);
  const colorMotion =
    motion * resolveGradientSpeed(state.settings.gradientSpeed);
  const font = resolveFont(state.settings.logoFont),
    visual = resolveVisual(state.settings.visualStyle);
  const fg = (s: string, rgb: readonly number[]) =>
    color ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[38;2;241;229;255m` : s;
  const ink = (s: string) => fg(s, [241, 229, 255]),
    dim = (s: string) => fg(s, colors.muted);
  const pink = (s: string) => fg(s, colors.primary),
    cyan = (s: string) => fg(s, colors.secondary),
    lime = (s: string) => fg(s, colors.selection);
  const ext = (v: unknown) => safeText(v, 900);
  const lang = resolveLanguage(state.settings.language);
  const en = lang === "en";
  if (width < 24 || height < 9) {
    const rows = [APP_NAME];
    if (view.form)
      rows.push(
        ext(view.form.title),
        view.form.secret
          ? "•".repeat(Math.min(80, [...view.form.value].length))
          : ext(view.form.value),
        "Enter / Esc",
      );
    else rows.push(tr(lang, "请放大窗口", "Resize terminal"));
    const marginPad = " ".repeat(margin);
    return {
      width,
      height,
      header: [],
      body: Array.from(
        { length: height },
        (_, i) => bg + pad(rows[i] ? (width >= 24 ? marginPad + rows[i]! : rows[i]!) : "", width - 1),
      ),
      form: [],
      footer: [],
      separator: [],
    };
  }
  const a = state.accounts.find((x) => x.id === view.accountId),
    c = state.settings.compatibility,
    privacy = state.settings.privacyMode === true;
  const status = !c
    ? tr(lang, "尚未检查", "UNCHECKED")
    : Date.now() < c.checkedAt || Date.now() - c.checkedAt >= 6 * 3600_000
      ? tr(lang, "需要复查", "RECHECK DUE")
      : c.status === "ok"
        ? tr(lang, "未发现更新", "UP TO DATE")
        : c.status === "update"
          ? tr(lang, "需要更新", "UPDATE REQUIRED")
          : tr(lang, "检查失败", "PROBE FAILED");
  const focused =
    a ??
    (view.screen === "home" ? state.accounts[view.selected] : undefined) ??
    state.accounts[0];
  const activeSchoolId = focused?.school.id || state.settings.schoolId || "";
  const schoolCode = activeSchoolId
    ? privacy
      ? maskText(activeSchoolId)
      : ext(activeSchoolId)
    : tr(lang, "待配置", "UNSET");
  const campusName = resolveCampusLabel(state, lang, focused);
  const hasNamedSchool = Boolean(focused?.school.name || state.settings.schoolName);
  const school = `${privacy && hasNamedSchool ? maskText(campusName) : ext(campusName)} · ${schoolCode}`;
  let header: string[] = [];
  const brand = `${gradient(APP_NAME, colorMotion, color, theme)} ${dim("v" + APP_VERSION)}${demo ? pink("  DEMO") : ""}`;
  const metadata = `${cyan(school)}  ${c?.status === "ok" ? lime(status) : pink(status)}${privacy ? "  " + pink(tr(lang, "隐私模式", "PRIVACY MASK")) : ""}`;
  const wordmarkScreens = new Set([
    "home",
    "menu",
    "account",
    "manage",
    "appearance",
    "settings",
    "libraries",
    "tasks",
    "executions",
  ]);
  const minWordmarkHeight = view.form ? 28 : 22;
  if (
    font !== "plain" &&
    wordmarkScreens.has(view.screen) &&
    width >= 64 &&
    height >= minWordmarkHeight &&
    EDGE_LOGO_WIDTH <= inner &&
    wordmarkRows.length <= Math.min(12, height - (view.form ? 18 : 13))
  ) {
    const logo = wordmark(colorMotion, color, theme, font);
    header = [...logo, brand + "    " + metadata, ""];
  } else header = [brand, metadata, ""];
  const backdrop =
    view.screen !== "fonts" &&
    width >= 48 &&
    height >= 18 &&
    visual !== "none";
  const minimap = backdrop ? activeMinimap(view) : undefined;
  const fontPreview =
    view.screen === "fonts" && !view.form && width >= 80 && height >= 20;
  const leftWidth = fontPreview
    ? Math.min(34, Math.floor(inner * 0.35))
    : minimap?.length && inner >= 76
      ? Math.min(56, Math.floor(inner * 0.54))
      : backdrop
        ? Math.min(80, Math.max(Math.min(68, inner), Math.floor(inner * 0.64)))
        : inner;
  const { body, selectedRow, anchor } = pageContent({
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
  });
  const footer: string[] = [];
  if (!view.form) {
    const notice = view.processing ? tr(lang, "正在处理…", "Working…") : view.notice;
    if (notice) footer.push(...wrap(ext(notice), inner).slice(0, 2).map(ink));
    const pageActions = workoutPageActions(view, state) ?? taskPageActions(view, state, demo);
    const privacyKey = en
      ? privacy
        ? "X Unmask"
        : "X Mask"
      : privacy
        ? "X 显示"
        : "X 隐私";
    const langKey = en ? "L Lang:ZH" : "L EN";
    const keys = pageActions
      ? pageActions.flatMap((action) => (action.hint ? [action.hint] : []))
      : view.screen === "home"
        ? en
          ? height < 14
            ? ["Enter Open", "C Check", privacyKey, langKey, "/ More", "Q Quit"]
            : ["Enter Open", "Space Mark", "P Plan", "T Tasks", "H Log", "N Notices", "C Check", privacyKey, langKey, "/ More", "Q Quit"]
          : height < 14
            ? ["Enter 打开", "C 更新", privacyKey, langKey, "/ 更多", "Q 关闭"]
            : ["Enter 打开", "Space 多选", "P 计划", "T 任务", "H 记录", "N 通知", "C 更新", privacyKey, langKey, "/ 更多", "Q 关闭"]
        : view.screen === "information"
          ? en
            ? ["↑↓ / PgUp PgDn Scroll", "R Refresh", "Esc Back"]
            : ["↑↓ / PgUp PgDn 滚动", "R 刷新", "Esc 返回"]
          : view.screen === "school"
            ? en
              ? ["1–2 Switch", "↑↓ Scroll", "Tab Account", "R Refresh", "Esc Back"]
              : ["1–2 切换", "↑↓ 滚动", "Tab 读取账号", "R 刷新", "Esc 返回"]
            : view.screen === "notices"
              ? en
                ? ["↑↓ Select", "Enter Read", "Tab Account", "R Refresh", "Esc Back"]
                : ["↑↓ 选择", "Enter 详情", "Tab 读取账号", "R 刷新", "Esc 返回"]
              : view.screen === "appearance"
              ? en
                ? ["↑↓ Select", "← → / Enter Toggle", "Esc Back"]
                : ["↑↓ 选择", "← → / Enter 切换", "Esc 返回"]
              : view.screen === "fonts"
                ? en
                  ? ["↑↓ / PgUp PgDn Preview", "/ Filter", "Enter Save", "Esc Back"]
                  : ["↑↓ / PgUp PgDn 预览", "/ 搜索", "Enter 保存", "Esc 返回"]
                : view.screen === "manage"
                  ? en
                    ? ["↑↓ Select", "Enter Edit", "C Probe Proxy", "Esc Back"]
                    : ["↑↓ 选择", "Enter 设置", "C 检查出口", "Esc 返回"]
                  : view.screen === "libraries"
                    ? en
                      ? [
                          "↑↓ Select",
                          "Enter Open",
                          "I Import File",
                          "P Read Phone",
                          ...(state.libraries.length ? ["D Delete"] : []),
                          "Esc Back",
                        ]
                      : [
                          "↑↓ 选择",
                          "Enter 打开",
                          "I 文件导入",
                          "P 连接手机读取",
                          ...(state.libraries.length ? ["D 删除"] : []),
                          "Esc 返回",
                        ]
                    : view.screen === "settings"
                      ? en
                        ? ["↑↓ Select", "← → / Enter Configure", "Esc Back"]
                        : ["↑↓ 选择", "← → / Enter 设置", "Esc 返回"]
                      : en
                        ? ["↑↓ Select", "Enter Confirm", "Esc Back"]
                        : ["↑↓ 选择", "Enter 确定", "Esc 返回"];
    const keyLines = keyRows(keys, inner);
    footer.push(...keyLines.map(dim));
  }
  const form: string[] = [];
  if (view.form) {
    form.push(
      pink(ext(view.form.title)),
      ...wrap(ext(view.form.label), inner).slice(0, 3).map(cyan),
    );
    const value = view.form.secret
      ? "•".repeat(Math.min(80, [...view.form.value].length))
      : ext(view.form.value);
    form.push(
      pink("❯ ") + lime(clip(value, inner - 3)) + pink("_"),
      ...wrap(ext(view.form.hint ?? tr(lang, "Enter 确认 · Esc 取消", "Enter Confirm · Esc Cancel")), inner)
        .slice(0, 2)
        .map(dim),
    );
  }
  const separator = !view.form && height >= 16 ? 1 : 0;
  while (
    header.length + form.length + footer.length + separator + 1 > height &&
    header.length > 1
  )
    header.pop();
  const available = Math.max(
    0,
    height - header.length - footer.length - form.length - separator,
  );
  let shown = body;
  if (body.length > available) {
    const fixed = Math.min(anchor, Math.max(0, available - 1)),
      space = Math.max(0, available - fixed);
    const offset = Math.min(
      Math.max(0, body.length - fixed - space),
      Math.max(0, selectedRow - fixed - Math.floor(space / 2)),
    );
    shown = [
      ...body.slice(0, fixed),
      ...body.slice(fixed + offset, fixed + offset + space),
    ];
  } else if (shown.length < available) {
    shown = shown.slice();
    while (shown.length < available) shown.push("");
  }
  if (fontPreview && available >= 8) {
    const selected = filterFonts(view.fontQuery)[view.selected];
    if (selected) {
      if (shown === body) shown = shown.slice();
      const art = wordmark(colorMotion, color, theme, selected),
        x = leftWidth + 4,
        room = Math.max(1, inner - x);
      const preview = [
        cyan(fontLabel(selected, lang)),
        dim(`${Math.max(...art.map(cells))} × ${art.length}`),
        "",
        ...art,
      ];
      preview
        .slice(0, available)
        .forEach(
          (s, i) => (shown[i] = pad(shown[i] ?? "", x) + bg + clip(s, room)),
        );
    }
  }
  const content = [
    ...header,
    ...shown,
    ...form,
    ...(separator ? [""] : []),
    ...footer,
  ];
  const marginPad = " ".repeat(margin);
  const artRows = backdrop ? header.length + shown.length : 0;
  const sepRow = separator ? header.length + shown.length + form.length : -1;
  const outRows: string[] = new Array(height);

  if (artRows > 0) {
    const widths = new Uint16Array(artRows);
    for (let i = 0; i < artRows; i++) {
      const line = content[i];
      widths[i] = line ? Math.min(inner, cells(stripAnsi(line).trimEnd())) : 0;
    }
    const masks = new Uint16Array(artRows);
    for (let i = 0; i < artRows; i++) {
      const inkWidth = widths[i]!;
      const bridged =
        inkWidth ||
        (i > 0 && i + 1 < artRows && widths[i - 1] && widths[i + 1]
          ? Math.min(widths[i - 1]!, widths[i + 1]!)
          : 0);
      masks[i] = bridged ? Math.min(inner, bridged + 2) : 0;
    }
    const opacity = resolveVisualOpacity(state.settings.visualOpacity);
    const art = minimap?.length
      ? minimapArtwork(
          minimap,
          inner,
          artRows,
          motion,
          color,
          theme,
          colorMotion,
          Math.max(opacity, 75),
          masks,
        )
      : visualRenderers[visual](
          inner,
          artRows,
          motion,
          color,
          theme,
          colorMotion,
          opacity,
          masks,
          activePulse(state),
        );
    const limit = Math.min(height, artRows);
    for (let i = 0; i < limit; i++) {
      const mask = masks[i]!,
        inkWidth = widths[i]!;
      outRows[i] =
        bg +
        marginPad +
        (mask ? bg + pad(clip(content[i] ?? "", inkWidth), mask) : "") +
        art[i]! +
        bg +
        marginPad;
    }
  }

  for (let i = artRows; i < height; i++) {
    if (i === sepRow) {
      outRows[i] = bg + gradientLine(width - 1, colorMotion, color, theme);
    } else {
      const line = content[i];
      outRows[i] = bg + pad(line ? marginPad + line : "", width - 1);
    }
  }

  return {
    width,
    height,
    header: [],
    body: outRows,
    form: [],
    footer: [],
    separator: [],
  };
}
