import type { AccountView } from "../app/contracts.js";
import { safeText, type Language, type Task } from "../core/model.js";
import { taskPhaseNames, taskPhaseNamesEn } from "./task-view.js";
export const stripAnsi = (v: string) =>
  v.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const graphemes = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const narrow = /^[\x20-\x7e\u2500-\u259f\u2800-\u28ff]*$/u;
const complexText =
  /[\p{Mark}\p{Cf}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const surrogate = /[\ud800-\udfff]/;
const needsGraphemes = (text: string) =>
  complexText.test(text) || surrogate.test(text);
function simpleWidth(code: number) {
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
    ? 2
    : 1;
}
function glyphWidth(s: string) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return 2;
  const base = [...s].find((c) => !/[\p{Mark}\p{Cf}]/u.test(c));
  if (!base) return 0;
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\ufe10-\ufe6f\uff01-\uff60\uffe0-\uffe6]/u.test(
    base,
  )
    ? 2
    : 1;
}
type MeasuredText = { units: Array<readonly [string, number]>; width: number };
const measuredText = new Map<string, MeasuredText>();
function measure(text: string): MeasuredText {
  const old = measuredText.get(text);
  if (old) return old;
  const units = needsGraphemes(text)
    ? Array.from(
        graphemes.segment(text),
        ({ segment }) => [segment, glyphWidth(segment)] as const,
      )
    : Array.from(
        text,
        (segment) => [segment, simpleWidth(segment.charCodeAt(0))] as const,
      );
  const result = {
    units,
    width: units.reduce((sum, [, width]) => sum + width, 0),
  };
  if (text.length <= 320) {
    measuredText.set(text, result);
    if (measuredText.size > 256)
      measuredText.delete(measuredText.keys().next().value!);
  }
  return result;
}
export function cells(v: string) {
  const plain = stripAnsi(v);
  if (narrow.test(plain)) return plain.length;
  if (needsGraphemes(plain)) return measure(plain).width;
  let width = 0;
  for (let i = 0; i < plain.length; i++)
    width += simpleWidth(plain.charCodeAt(i));
  return width;
}
export function clip(v: string, width: number) {
  let out = "",
    used = 0;
  for (const token of v.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g) ?? []) {
    if (token.startsWith("\x1b[")) {
      out += token;
      continue;
    }
    if (narrow.test(token)) {
      const remaining = width - used;
      if (token.length > remaining)
        return out + token.slice(0, Math.max(0, remaining));
      out += token;
      used += token.length;
      continue;
    }
    for (const [segment, n] of measure(token).units) {
      if (used + n > width) return out;
      out += segment;
      used += n;
    }
  }
  return out;
}
export function pad(v: string, width: number) {
  const s = clip(v, Math.max(0, width));
  return s + " ".repeat(Math.max(0, width - cells(s)));
}
export function wrap(v: string, width: number): string[] {
  const lines: string[] = [];
  let row = "",
    used = 0;
  for (const [segment, n] of measure(v).units) {
    if (used + n > width && row) {
      lines.push(row);
      row = "";
      used = 0;
    }
    row += segment;
    used += n;
  }
  if (row || !lines.length) lines.push(row);
  return lines;
}
export function keyRows(keys: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const key of keys) {
    if (row && cells(row + "   " + key) > width) {
      rows.push(row);
      row = "";
    }
    if (cells(key) > width) {
      if (row) {
        rows.push(row);
        row = "";
      }
      rows.push(...wrap(key, width));
    } else row += (row ? "   " : "") + key;
  }
  if (row) rows.push(row);
  return rows;
}
export const mask = (v: string) => safeText(v, 80);
export const phaseLabel = (t: Pick<Task, "phase">, lang: Language = "zh") =>
  lang === "en" ? taskPhaseNamesEn[t.phase] : taskPhaseNames[t.phase];
export const sessionLabel = (a: AccountView, lang: Language = "zh") =>
  !a.session || a.session.status === "invalid"
    ? lang === "en"
      ? "Login Req"
      : "需登录"
    : lang === "en"
      ? "Ready"
      : "已登录";
const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
export const clock = (ms: number) => clockFormatter.format(ms);
const shortDateFormatter = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export const shortDateTime = (ms: number) => shortDateFormatter.format(ms);
