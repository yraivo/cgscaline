import type { ColorTheme, LogoFont, VisualStyle } from '../core/model.js';
import type { MinimapPoint } from './minimap.js';
import { wordmarkRows } from './wordmark.js';
import { trackArt, spiralArt, routeMinimapArt, type TaskPulse } from './terminal-art.js';
export type { TaskPulse };
export { fontNames, resolveFont } from './logo-fonts.js';
export type RGB = readonly [number, number, number];
export type MutableRGB = [number, number, number];
const INK = '\x1b[38;2;241;229;255m';
export const CANVAS = '\x1b[48;2;14;4;29m' + INK;
export const themeNames: Record<ColorTheme, string> = {
  astolfo: 'Astolfo',
  spectrum: 'Spectrum',
  mescaline: 'Mescaline',
  acid: 'Acid',
};
export const colorThemes: readonly ColorTheme[] = ['astolfo', 'spectrum', 'mescaline', 'acid'];
export const resolveTheme = (v: unknown): ColorTheme =>
  v === 'astolfo' || v === 'spectrum' || v === 'acid' ? v : 'mescaline';
export const visualNames: Record<VisualStyle, string> = {
  track: '光轨跑道',
  spiral: '螺旋',
  none: '关闭',
};
export const resolveVisual = (v: unknown): VisualStyle =>
  v === 'spiral' || v === 'none' ? v : 'track';

function writeHsv(h: number, s: number, v: number, out: MutableRGB): MutableRGB {
  const hh = (((h % 1) + 1) % 1) * 6;
  const c = v * s, x = c * (1 - Math.abs((hh % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  out[0] = Math.round((r + m) * 255);
  out[1] = Math.round((g + m) * 255);
  out[2] = Math.round((b + m) * 255);
  return out;
}

const astolfoStops: readonly RGB[] = [[255, 133, 192], [205, 163, 251], [128, 201, 255], [205, 163, 251], [255, 133, 192]];
const mescalineStops: readonly RGB[] = [[176, 72, 255], [255, 46, 166], [255, 154, 68], [66, 245, 255], [176, 72, 255]];
const acidStops: readonly RGB[] = [[162, 48, 255], [255, 36, 184], [0, 255, 230], [196, 255, 48], [162, 48, 255]];

function writeStops(stops: readonly RGB[], position: number, brightness: number, out: MutableRGB): MutableRGB {
  const rem = ((position % 1) + 1) % 1;
  const p = rem * (stops.length - 1), i = Math.min(stops.length - 2, p | 0), t = p - i;
  const a = stops[i]!, b = stops[i + 1]!;
  out[0] = Math.round((a[0] + (b[0] - a[0]) * t) * brightness);
  out[1] = Math.round((a[1] + (b[1] - a[1]) * t) * brightness);
  out[2] = Math.round((a[2] + (b[2] - a[2]) * t) * brightness);
  return out;
}

export function paletteWrite(theme: ColorTheme, position: number, out: MutableRGB, brightness = 1): MutableRGB {
  if (theme === 'spectrum') return writeHsv(position, .87, brightness, out);
  if (theme === 'mescaline') return writeStops(mescalineStops, position, brightness, out);
  if (theme === 'acid') return writeStops(acidStops, position, brightness, out);
  return writeStops(astolfoStops, position, brightness, out);
}

export function paletteColor(theme: ColorTheme, position: number, brightness = 1): RGB {
  return paletteWrite(theme, position, [0, 0, 0], brightness);
}

const ACCENT_TABLE = {
  astolfo: { primary: [255, 149, 203], secondary: [153, 205, 255], selection: [255, 198, 228], success: [205, 180, 255], muted: [177, 155, 197], warning: [255, 193, 166], error: [255, 111, 155] },
  mescaline: { primary: [255, 94, 186], secondary: [88, 242, 255], selection: [255, 186, 92], success: [132, 250, 214], muted: [188, 148, 218], warning: [255, 176, 104], error: [255, 88, 136] },
  acid: { primary: [255, 58, 196], secondary: [46, 255, 232], selection: [206, 255, 64], success: [164, 255, 96], muted: [182, 142, 226], warning: [255, 204, 88], error: [255, 76, 142] },
  spectrum: { primary: [255, 73, 217], secondary: [79, 255, 225], selection: [226, 255, 84], success: [226, 255, 84], muted: [178, 145, 216], warning: [255, 193, 116], error: [255, 101, 151] },
};
export function accents(theme: ColorTheme) {
  return ACCENT_TABLE[theme];
}

export function dye(text: string, rgb: RGB, color: boolean) {
  return color ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}${INK}` : text;
}

const gradScratch: MutableRGB = [0, 0, 0];
export function gradient(text: string, motion: number, color: boolean, theme: ColorTheme, offset = 0) {
  if (!color || !text) return text;
  let out = '', last = -1, idx = 0;
  for (const c of text) {
    if (c === ' ') { out += ' '; idx++; continue; }
    paletteWrite(theme, idx * .017 + motion * .035 + offset, gradScratch);
    const code = (gradScratch[0] << 16) | (gradScratch[1] << 8) | gradScratch[2];
    if (code !== last) {
      out += `\x1b[38;2;${gradScratch[0]};${gradScratch[1]};${gradScratch[2]}m`;
      last = code;
    }
    out += c;
    idx++;
  }
  return out + INK;
}

export function gradientLine(width: number, motion: number, color: boolean, theme: ColorTheme) {
  const n = Math.max(0, width);
  if (!color || n <= 0) return '─'.repeat(n);
  const denom = Math.max(1, n - 1), base = motion * .025;
  let out = '', last = -1;
  for (let x = 0; x < n; x++) {
    paletteWrite(theme, (x / denom) * .8 + base, gradScratch);
    const code = (gradScratch[0] << 16) | (gradScratch[1] << 8) | gradScratch[2];
    if (code !== last) {
      out += `\x1b[38;2;${gradScratch[0]};${gradScratch[1]};${gradScratch[2]}m`;
      last = code;
    }
    out += '─';
  }
  return out + INK;
}

export function wordmark(motion: number, color: boolean, theme: ColorTheme = 'astolfo', font: LogoFont = 'figlet:The Edge'): string[] {
  return (font === 'plain' ? ['C G S C A L I N E'] : wordmarkRows).map((row, y) =>
    gradient(row, motion + y * .55 + Math.sin(y * .75) * .35, color, theme),
  );
}

export type VisualRenderer = (
  width: number,
  height: number,
  motion: number,
  color: boolean,
  theme: ColorTheme,
  colorMotion?: number,
  opacity?: number,
  rowSkips?: ArrayLike<number>,
  pulse?: TaskPulse,
) => string[];

export const neonTrack: VisualRenderer = (width, height, motion, color, theme, colorMotion = motion, opacity, rowSkips, pulse) =>
  trackArt(width, height, motion, color, (pos, out) => paletteWrite(theme, pos, out), colorMotion, opacity, rowSkips, pulse);

export const spiral: VisualRenderer = (width, height, motion, color, theme, colorMotion = motion, opacity, rowSkips, pulse) =>
  spiralArt(width, height, motion, color, (pos, out) => paletteWrite(theme, pos, out), colorMotion, opacity, rowSkips, pulse);

export function minimapArtwork(
  points: readonly MinimapPoint[],
  width: number,
  height: number,
  motion: number,
  color: boolean,
  theme: ColorTheme,
  colorMotion = motion,
  opacity?: number,
  rowSkips?: ArrayLike<number>,
): string[] {
  return routeMinimapArt(points, width, height, motion, color, (pos, out) => paletteWrite(theme, pos, out), colorMotion, opacity, rowSkips);
}

export const visualRenderers: Readonly<Record<VisualStyle, VisualRenderer>> = Object.freeze({
  track: neonTrack,
  spiral,
  none: () => [],
});
