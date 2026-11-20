import type { AccountView } from '../app/contracts.js';
import { cachedInformation, UserError, type Account, type Language } from '../core/model.js';

function clockMsInShanghai(h: number, m: number, sec: number, now: number): number {
  const d = new Date(now + 8 * 3600_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, sec) - 8 * 3600_000;
}

function parseClockParts(text: string): [number, number, number] | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return undefined;
  return [hh, mm, ss];
}

/**
 * 支持：
 * - 现在 / 立即 / 空字符串
 * - +分钟（如 +10）
 * - 固定时刻（如 21:30 或 21:30:15）
 * - 时段随机窗口（如 17:20-18:10 或 17:20~18:10，精确到秒均匀抖动）
 * - 中心时刻抖动（如 21:30±10 或 21:30+-10）
 * - 智能 / auto（白天与傍晚自动落在自然时段并带随机秒级偏移）
 */
export function parseStart(value: string, now = Date.now(), rng: () => number = Math.random): number {
  const v = value.trim();
  if (!v || v === '现在' || v === '立即' || v.toLowerCase() === 'now') return now;
  if (/^\+\d+$/.test(v)) return now + Number(v.slice(1)) * 60_000;

  if (v === '智能' || v.toLowerCase() === 'auto') {
    const sh = new Date(now + 8 * 3600_000);
    const mins = sh.getUTCHours() * 60 + sh.getUTCMinutes();
    if (mins >= 7 * 60 && mins <= 21 * 60 + 20) {
      return now + Math.round((3 + rng() * 12) * 60_000);
    }
    let start = clockMsInShanghai(17, 25, 0, now);
    if (start + 60 * 60_000 <= now) start += 86400_000;
    const lo = Math.max(now + 60_000, start);
    const hi = Math.max(lo, start + 60 * 60_000);
    return Math.round(lo + rng() * (hi - lo));
  }

  const pm = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:±|\+-)\s*(\d{1,3})$/.exec(v);
  if (pm) {
    const parts = parseClockParts(pm[1]!);
    const spanMin = Number(pm[2]!);
    if (!parts || !Number.isFinite(spanMin) || spanMin < 1 || spanMin > 180)
      throw new UserError('抖动格式示例：21:30±10（1–180 分钟）。');
    let center = clockMsInShanghai(parts[0], parts[1], parts[2], now);
    if (center + spanMin * 60_000 < now) center += 86400_000;
    const lo = Math.max(now, center - spanMin * 60_000);
    const hi = Math.max(lo, center + spanMin * 60_000);
    return Math.round(lo + rng() * (hi - lo));
  }

  const win = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~～—]\s*(\d{1,2}:\d{2}(?::\d{2})?)$/.exec(v);
  if (win) {
    const a = parseClockParts(win[1]!), b = parseClockParts(win[2]!);
    if (!a || !b) throw new UserError('时段窗口格式示例：17:20-18:10。');
    let start = clockMsInShanghai(a[0], a[1], a[2], now);
    let end = clockMsInShanghai(b[0], b[1], b[2], now);
    if (end <= start) end += 86400_000;
    if (end < now) {
      start += 86400_000;
      end += 86400_000;
    }
    const lo = Math.max(now, start);
    return Math.round(lo + rng() * Math.max(0, end - lo));
  }

  const exact = parseClockParts(v);
  if (!exact) throw new UserError('请输入现在、+分钟、HH:mm、17:20-18:10 或 智能。');
  let t = clockMsInShanghai(exact[0], exact[1], exact[2], now);
  if (t < now) t += 86400_000;
  return t;
}

function parseShanghaiEndMs(text: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return undefined;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 23),
    Number(m[5] ?? 59),
    Number(m[6] ?? 59),
  ) - 8 * 3600_000;
}

export interface TermPlanSummary {
  completed?: number;
  target?: number;
  remaining?: number;
  daysLeft?: number;
  weeklyPace?: number;
  line: string;
}

export function termPlanSummary(
  account: Account | AccountView | undefined,
  termTarget?: number,
  now = Date.now(),
  lang: Language = 'zh',
): TermPlanSummary | undefined {
  if (!account) return undefined;
  const info = cachedInformation(account);
  if (!info) return undefined;

  let completed = info.statistics.data?.count;
  if (completed === undefined && info.totals.data?.length) {
    const runItem = info.totals.data.find(t => /跑步|有效|次数|run|valid/i.test(t.label));
    const parsed = runItem ? Number(runItem.value) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) completed = parsed;
  }

  const currentTerm = info.terms.data?.find(t => t.current) ?? info.terms.data?.[0];
  const endMs = currentTerm?.end ? parseShanghaiEndMs(currentTerm.end) : undefined;
  const daysLeft = endMs !== undefined ? Math.max(0, Math.ceil((endMs - now) / 86400_000)) : undefined;

  if (completed === undefined && daysLeft === undefined) return undefined;

  const target = typeof termTarget === 'number' && termTarget > 0 ? Math.floor(termTarget) : undefined;
  const parts: string[] = [];

  if (lang === 'en') {
    if (completed !== undefined && target !== undefined) {
      const remaining = Math.max(0, target - completed);
      parts.push(`Goal ${completed}/${target}`);
      if (remaining === 0) {
        parts.push('Completed');
      } else {
        parts.push(`${remaining} left`);
        if (daysLeft !== undefined && daysLeft > 0) {
          const weekly = Number((remaining / Math.max(1, daysLeft / 7)).toFixed(1));
          parts.push(`${daysLeft}d rem · ~${weekly}/wk`);
          return { completed, target, remaining, daysLeft, weeklyPace: weekly, line: parts.join(' · ') };
        }
      }
      if (daysLeft !== undefined) parts.push(`${daysLeft}d rem`);
      return { completed, target, remaining, daysLeft, line: parts.join(' · ') };
    }
    if (completed !== undefined) parts.push(`Valid ${completed}`);
    if (daysLeft !== undefined) parts.push(`${daysLeft}d left in term`);
    return { completed, target, daysLeft, line: parts.join(' · ') };
  }

  if (completed !== undefined && target !== undefined) {
    const remaining = Math.max(0, target - completed);
    parts.push(`进度 ${completed}/${target} 次`);
    if (remaining === 0) {
      parts.push('已达标');
    } else {
      parts.push(`还差 ${remaining} 次`);
      if (daysLeft !== undefined && daysLeft > 0) {
        const weekly = Number((remaining / Math.max(1, daysLeft / 7)).toFixed(1));
        parts.push(`剩 ${daysLeft} 天 · 建议每周 ${weekly} 次`);
        return { completed, target, remaining, daysLeft, weeklyPace: weekly, line: parts.join(' · ') };
      }
    }
    if (daysLeft !== undefined) parts.push(`剩 ${daysLeft} 天`);
    return { completed, target, remaining, daysLeft, line: parts.join(' · ') };
  }

  if (completed !== undefined) parts.push(`有效 ${completed} 次`);
  if (daysLeft !== undefined) parts.push(`距结课剩 ${daysLeft} 天`);
  return { completed, target, daysLeft, line: parts.join(' · ') };
}
