import type { MutableRGB, RGB } from './chroma.js';
import type { MinimapPoint } from './minimap.js';

export type PaletteWriter = (position: number, out: MutableRGB) => RGB | MutableRGB;
export interface TaskPulse {
  progress: number;
  countdownSec: number;
  committing?: boolean;
  activeCount?: number;
}

const BACK_R = 14, BACK_G = 4, BACK_B = 29;
const DOTS = [1, 8, 2, 16, 4, 32, 64, 128];
const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

/** One terminal cell contains eight geometric samples. Bloom is separate from the fine strokes. */
class LightSurface {
  readonly w: number;
  readonly h: number;
  private power: Float32Array;
  private red: Float32Array;
  private green: Float32Array;
  private blue: Float32Array;
  private energy: Float32Array;
  private cellR: Float32Array;
  private cellG: Float32Array;
  private cellB: Float32Array;
  private peak: Float32Array;
  private horizontal: Float32Array;
  private glowR: Float32Array;
  private glowG: Float32Array;
  private glowB: Float32Array;
  private bits: Uint8Array;

  constructor(readonly columns: number, readonly rows: number) {
    this.w = columns * 2;
    this.h = rows * 4;
    const size = this.w * this.h;
    this.power = new Float32Array(size);
    this.red = new Float32Array(size);
    this.green = new Float32Array(size);
    this.blue = new Float32Array(size);
    const cells = columns * rows;
    this.energy = new Float32Array(cells);
    this.cellR = new Float32Array(cells);
    this.cellG = new Float32Array(cells);
    this.cellB = new Float32Array(cells);
    this.peak = new Float32Array(cells);
    this.horizontal = new Float32Array(cells);
    this.glowR = new Float32Array(cells);
    this.glowG = new Float32Array(cells);
    this.glowB = new Float32Array(cells);
    this.bits = new Uint8Array(cells);
  }

  clear() {
    this.power.fill(0);
    this.red.fill(0);
    this.green.fill(0);
    this.blue.fill(0);
  }

  pointXY(x: number, y: number, r: number, g: number, b: number, power: number) {
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < -1 || iy < -1 || ix >= this.w || iy >= this.h) return;
    const fx = x - ix, fy = y - iy, w = this.w, h = this.h;
    const pArr = this.power, rArr = this.red, gArr = this.green, bArr = this.blue;
    for (let dy = 0; dy < 2; dy++) {
      const py = iy + dy;
      if (py < 0 || py >= h) continue;
      const wy = dy ? fy : 1 - fy;
      const rowOff = py * w;
      for (let dx = 0; dx < 2; dx++) {
        const px = ix + dx;
        if (px < 0 || px >= w) continue;
        const wxy = (dx ? fx : 1 - fx) * wy * 1.85;
        const p = power * (wxy > 1 ? 1 : wxy);
        const i = rowOff + px;
        if (p > pArr[i]!) pArr[i] = p;
        const rp = r * p, gp = g * p, bp = b * p;
        if (rp > rArr[i]!) rArr[i] = rp;
        if (gp > gArr[i]!) gArr[i] = gp;
        if (bp > bArr[i]!) bArr[i] = bp;
      }
    }
  }

  lineXY(ax: number, ay: number, bx: number, by: number, r: number, g: number, b: number, power: number) {
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax >= this.w && bx >= this.w) || (ay >= this.h && by >= this.h)) return;
    const dx = bx - ax, dy = by - ay;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.25));
    const inv = 1 / steps;
    for (let i = 0; i <= steps; i++) {
      const t = i * inv;
      this.pointXY(ax + dx * t, ay + dy * t, r, g, b, power);
    }
  }

  flareXY(px: number, py: number, r: number, g: number, b: number, power = 1) {
    const p55 = power * .55, p38 = power * .38;
    this.lineXY(px - 4.2, py, px + 4.2, py, r, g, b, p55);
    this.lineXY(px, py - 4.2, px, py + 4.2, r, g, b, p55);
    this.lineXY(px - 2.6, py - 2.6, px + 2.6, py + 2.6, r, g, b, p38);
    this.lineXY(px - 2.6, py + 2.6, px + 2.6, py - 2.6, r, g, b, p38);
    this.pointXY(px, py, r, g, b, power);
  }

  private blur(source: Float32Array, out: Float32Array) {
    const cols = this.columns, rows = this.rows, horiz = this.horizontal, maxX = cols - 1, maxY = rows - 1;
    for (let y = 0; y < rows; y++) {
      const base = y * cols;
      for (let x = 0; x < cols; x++) {
        const x0 = x > 1 ? x - 2 : 0;
        const x1 = x > 0 ? x - 1 : 0;
        const x3 = x < maxX ? x + 1 : maxX;
        const x4 = x + 1 < maxX ? x + 2 : maxX;
        horiz[base + x] = (source[base + x0]! + source[base + x1]! * 2 + source[base + x]! * 3 + source[base + x3]! * 2 + source[base + x4]!) * (1 / 9);
      }
    }
    for (let y = 0; y < rows; y++) {
      const y0 = (y > 1 ? y - 2 : 0) * cols;
      const y1 = (y > 0 ? y - 1 : 0) * cols;
      const y2 = y * cols;
      const y3 = (y < maxY ? y + 1 : maxY) * cols;
      const y4 = (y + 1 < maxY ? y + 2 : maxY) * cols;
      for (let x = 0; x < cols; x++) {
        out[y2 + x] = (horiz[y0 + x]! + horiz[y1 + x]! * 2 + horiz[y2 + x]! * 3 + horiz[y3 + x]! * 2 + horiz[y4 + x]!) * (1 / 9);
      }
    }
    return out;
  }

  render(color: boolean, opacity = 100, rowSkips?: ArrayLike<number>): string[] {
    const cols = this.columns, rows = this.rows, w = this.w;
    const energy = this.energy, reds = this.cellR, greens = this.cellG, blues = this.cellB, peak = this.peak, bits = this.bits;
    const pArr = this.power, rArr = this.red, gArr = this.green, bArr = this.blue;
    for (let y = 0; y < rows; y++) {
      const cellRow = y * cols, pyBase = y * 4;
      for (let x = 0; x < cols; x++) {
        const cell = cellRow + x, pxBase = x * 2;
        let e = 0, pk = 0, cr = 0, cg = 0, cb = 0, bMask = 0;
        for (let dy = 0; dy < 4; dy++) {
          const i0 = (pyBase + dy) * w + pxBase;
          const p0 = pArr[i0]!;
          if (p0 > 0) {
            e += p0;
            if (p0 > pk) pk = p0;
            cr += rArr[i0]!; cg += gArr[i0]!; cb += bArr[i0]!;
            if (p0 > .16) bMask |= DOTS[dy * 2]!;
          }
          const i1 = i0 + 1, p1 = pArr[i1]!;
          if (p1 > 0) {
            e += p1;
            if (p1 > pk) pk = p1;
            cr += rArr[i1]!; cg += gArr[i1]!; cb += bArr[i1]!;
            if (p1 > .16) bMask |= DOTS[dy * 2 + 1]!;
          }
        }
        energy[cell] = e; peak[cell] = pk;
        reds[cell] = cr; greens[cell] = cg; blues[cell] = cb;
        bits[cell] = bMask;
      }
    }
    const glowR = color ? this.blur(reds, this.glowR) : undefined;
    const glowG = color ? this.blur(greens, this.glowG) : undefined;
    const glowB = color ? this.blur(blues, this.glowB) : undefined;
    const dimmed = color && opacity < 100;
    const ratio = dimmed ? clamp(opacity / 100, 0.1, 1) : 1;
    const fgAmt = dimmed ? +(ratio * 0.95).toFixed(3) : 1;
    const bgAmt = dimmed ? +(ratio * 0.65).toFixed(3) : 1;
    const tailEnd = color
      ? dimmed
        ? `\x1b[48;2;14;4;29m\x1b[38;2;${Math.round(BACK_R + (241 - BACK_R) * fgAmt)};${Math.round(BACK_G + (229 - BACK_G) * fgAmt)};${Math.round(BACK_B + (255 - BACK_B) * fgAmt)}m`
        : '\x1b[48;2;14;4;29m\x1b[38;2;241;229;255m'
      : '';
    const out: string[] = new Array(rows);
    for (let y = 0; y < rows; y++) {
      const startX = rowSkips ? Math.min(cols, Math.max(0, rowSkips[y] ?? 0)) : 0;
      if (startX >= cols) {
        out[y] = '';
        continue;
      }
      let row = '', lastFG = -1, lastBG = -1;
      const rowBase = y * cols;
      for (let x = startX; x < cols; x++) {
        const i = rowBase + x, bMask = bits[i]!;
        const glyph = bMask ? String.fromCharCode(0x2800 + bMask) : ' ';
        if (!color) { row += glyph; continue; }
        const leftIdx = rowBase + (x > 0 ? x - 1 : 0), rightIdx = rowBase + (x + 1 < cols ? x + 1 : cols - 1);
        const rGlow = glowR![i]! * .72 + glowR![leftIdx]! * .28;
        const bGlow = glowB![i]! * .72 + glowB![rightIdx]! * .28;
        let bgR = clamp(BACK_R + Math.round(rGlow * .032 / 4) * 4, 0, 255);
        let bgG = clamp(BACK_G + Math.round(glowG![i]! * .032 / 4) * 4, 0, 255);
        let bgB = clamp(BACK_B + Math.round(bGlow * .032 / 4) * 4, 0, 255);
        if (dimmed) {
          bgR = Math.round(BACK_R + (bgR - BACK_R) * bgAmt);
          bgG = Math.round(BACK_G + (bgG - BACK_G) * bgAmt);
          bgB = Math.round(BACK_B + (bgB - BACK_B) * bgAmt);
        }
        const bgCode = (bgR << 16) | (bgG << 8) | bgB;
        if (bgCode !== lastBG) {
          row += `\x1b[48;2;${bgR};${bgG};${bgB}m`;
          lastBG = bgCode;
        }
        if (bMask) {
          const pk = peak[i]!, en = energy[i]!;
          const scale = (.58 + (pk > 1 ? 1 : pk) * .68) / (en > .01 ? en : .01);
          let fgR = clamp(Math.round((reds[i]! * scale) / 4) * 4, 0, 255);
          let fgG = clamp(Math.round((greens[i]! * scale) / 4) * 4, 0, 255);
          let fgB = clamp(Math.round((blues[i]! * scale) / 4) * 4, 0, 255);
          if (dimmed) {
            fgR = Math.round(BACK_R + (fgR - BACK_R) * fgAmt);
            fgG = Math.round(BACK_G + (fgG - BACK_G) * fgAmt);
            fgB = Math.round(BACK_B + (fgB - BACK_B) * fgAmt);
          }
          const fgCode = (fgR << 16) | (fgG << 8) | fgB;
          if (fgCode !== lastFG) {
            row += `\x1b[38;2;${fgR};${fgG};${fgB}m`;
            lastFG = fgCode;
          }
        }
        row += glyph;
      }
      out[y] = row + tailEnd;
    }
    return out;
  }
}

let retainedSurface: LightSurface | undefined;
function surfaceFor(width: number, height: number) {
  if (retainedSurface?.columns !== width || retainedSurface.rows !== height) retainedSurface = new LightSurface(width, height);
  else retainedSurface.clear();
  return retainedSurface;
}

const ptScratch = [0, 0];
function writeTrackPoint(t: number, r: number, out: number[], half = .78) {
  const straight = half * 2, arc = Math.PI * r, length = straight * 2 + arc * 2;
  const rem = ((t % 1) + 1) % 1;
  let s = rem * length;
  if (s < straight) { out[0] = -half + s; out[1] = r; return; }
  s -= straight;
  if (s < arc) { const a = Math.PI / 2 - s / r; out[0] = half + r * Math.cos(a); out[1] = r * Math.sin(a); return; }
  s -= arc;
  if (s < straight) { out[0] = half - s; out[1] = -r; return; }
  s -= straight;
  const a = -Math.PI / 2 - s / r;
  out[0] = -half + r * Math.cos(a);
  out[1] = r * Math.sin(a);
}

function whiten(rgb: MutableRGB, amount: number) {
  rgb[0] += (255 - rgb[0]) * amount;
  rgb[1] += (255 - rgb[1]) * amount;
  rgb[2] += (255 - rgb[2]) * amount;
}

function dimensions(width: number, height: number) {
  return [Math.max(0, Math.floor(width)), Math.max(0, Math.floor(height))] as const;
}

const colorScratch: MutableRGB = [0, 0, 0];

export function trackArt(
  width: number,
  height: number,
  motion: number,
  color: boolean,
  palette: PaletteWriter,
  colorMotion: number,
  opacity = 100,
  rowSkips?: ArrayLike<number>,
  pulse?: TaskPulse,
): string[] {
  const [w, h] = dimensions(width, height);
  if (!w || !h) return [];
  const surface = surfaceFor(w, h);
  const urgency = pulse ? (pulse.committing ? 1 : clamp(1 - pulse.countdownSec / 60, 0, 1)) : 0;
  const yaw = .68 + Math.sin(motion * .22) * .055, pitch = .78 + Math.cos(motion * .18) * .04;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 160; i++) {
    writeTrackPoint(i / 160, 1.12, ptScratch);
    const x = ptScratch[0]! * c - ptScratch[1]! * s, z = ptScratch[0]! * s + ptScratch[1]! * c, k = 3.8 / (3.8 + z * .52);
    const px = x * k, py = z * pitch * k;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const scale = Math.min(Math.max(1, surface.w - 4) / (maxX - minX), Math.max(1, surface.h - 6) / (maxY - minY)) * .98;
  const centerX = (minX + maxX) * .5, centerY = (minY + maxY) * .5;
  const originX = surface.w * (w >= 96 ? .55 : .5), originY = surface.h * .49;

  let outX = 0, outY = 0;
  const projectMap = (px: number, py: number, lift: number) => {
    const x = px * c - py * s, z = px * s + py * c, k = 3.8 / (3.8 + z * .52);
    outX = (x * k - centerX) * scale + originX;
    outY = ((z * pitch - lift) * k - centerY) * scale + originY;
  };
  const mapTrack = (t: number, r: number, extraLift = 0) => {
    writeTrackPoint(t, r, ptScratch);
    const lift = Math.sin(t * Math.PI * 6 - motion * (1.2 + urgency * .9) + r * 2.4) * (.032 + urgency * .014) + extraLift;
    projectMap(ptScratch[0]!, ptScratch[1]!, lift);
  };
  const drawTrackPath = (nSteps: number, tFrom: number, tSpan: number, r: number, extraLift: number, cr: number, cg: number, cb: number, pwr: number) => {
    mapTrack(tFrom, r, extraLift);
    let prevX = outX, prevY = outY;
    const inv = 1 / nSteps;
    for (let i = 1; i <= nSteps; i++) {
      mapTrack(tFrom + tSpan * (i * inv), r, extraLift);
      surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, pwr);
      prevX = outX; prevY = outY;
    }
  };

  const phase = -colorMotion * .025, steps = Math.max(150, Math.round((surface.w + surface.h) * .88));

  // 1. Outer psychedelic Cherenkov shockwave rings & cosmic warp ribbons.
  const waveSpeed = .12 + urgency * .18;
  for (let echo = 0; echo < 4; echo++) {
    const wave = ((motion * waveSpeed + echo / 4) % 1 + 1) % 1;
    const r = 1.10 + wave * (.52 + urgency * .12), fade = (1 - wave * .75) * (.58 + urgency * .24);
    const dir = echo % 2 ? 1 : -1;
    for (let seg = 0; seg < 18; seg++) {
      if ((seg + echo) % 3 === 2) continue;
      const from = seg / 18 + motion * (.035 + urgency * .03) * dir, span = .82 / 18;
      palette(phase + echo * .19 + seg / 18 * .85, colorScratch);
      const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
      mapTrack(from, r, Math.cos(from * Math.PI * 8 + motion) * .045);
      let prevX = outX, prevY = outY;
      for (let i = 1; i <= 9; i++) {
        const t = i / 9;
        mapTrack(from + span * t, r, Math.cos((from + t * .05) * Math.PI * 8 + motion) * .045);
        surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, fade);
        prevX = outX; prevY = outY;
      }
    }
  }

  // 2. Infield sacred-geometry mandala & gravity-well vortex.
  const innerSteps = Math.max(72, Math.round(steps * .58));
  for (let inner = 0; inner < 3; inner++) {
    const r = .41 - inner * .11, depthLift = -(.48 - r) * .28;
    palette(phase + .33 + inner * .16, colorScratch);
    drawTrackPath(innerSteps, motion * .04 * (inner + 1), 1, r, depthLift, colorScratch[0], colorScratch[1], colorScratch[2], .46 + inner * .08);
  }
  const petals = 6, roseSteps = Math.max(96, Math.round(steps * .72));
  palette(phase + .62, colorScratch);
  whiten(colorScratch, .35);
  {
    const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
    let prevX = 0, prevY = 0;
    for (let i = 0; i <= roseSteps; i++) {
      const angle = (i / roseSteps) * Math.PI * 2;
      const rad = .10 + .28 * Math.abs(Math.cos(angle * (petals / 2) + motion * (.48 + urgency * .4)));
      const rot = angle - motion * (.24 + urgency * .18);
      projectMap(Math.cos(rot) * rad * 1.45, Math.sin(rot) * rad * .92, -.07 * Math.cos(angle * petals - motion));
      if (i > 0) surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, .72 + urgency * .2);
      prevX = outX; prevY = outY;
    }
  }

  // 3. Banked 3D suspension ties & harmonic cross-lattice across the 7 lanes.
  for (let i = 0; i < 60; i++) {
    const t = i / 60;
    palette(phase + t * .78, colorScratch);
    const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
    mapTrack(t, 1.05, -.075); const ax = outX, ay = outY;
    mapTrack(t, 1.05, .048);
    surface.lineXY(ax, ay, outX, outY, cr, cg, cb, .46 + urgency * .15);
    if (i % 2 === 0) {
      mapTrack(t, .50, -.015); const bx = outX, by = outY;
      mapTrack(t, 1.05, .015);
      surface.lineXY(bx, by, outX, outY, cr, cg, cb, .24 + urgency * .1);
    }
  }

  // 4. Seven undulating hyper-lanes with electric boundary rails.
  const segSteps = Math.ceil(steps / 14);
  for (let lane = 0; lane < 7; lane++) {
    const r = .52 + lane * .085, pwr = lane === 0 || lane === 6 ? 1.05 : .74;
    for (let segment = 0; segment < 14; segment++) {
      palette(phase + segment / 14 * .78 + lane * .058, colorScratch);
      drawTrackPath(segSteps, segment / 14, 1 / 14, r, 0, colorScratch[0], colorScratch[1], colorScratch[2], pwr);
    }
  }
  palette(phase + .54, colorScratch);
  whiten(colorScratch, .2);
  drawTrackPath(steps, 0, 1, 1.06, -.068, colorScratch[0], colorScratch[1], colorScratch[2], .68);

  // 5. Six warp-speed light-cycles with corkscrewing DNA plasma wakes & 8-ray starbursts.
  for (let lane = 0; lane < 6; lane++) {
    const r = .54 + lane * .096, speed = (.155 + (lane % 2) * .024) * (1 + urgency * .35), head = motion * speed + lane * .172;
    for (let i = 30; i >= 0; i--) {
      const t0 = head - i * .0039, t1 = t0 + .0043;
      const fade = 1 - i / 31, power = Math.pow(fade, 1.3) * 1.75;
      palette(phase + lane * .15 - i * .005, colorScratch);
      whiten(colorScratch, fade * .78);
      const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
      mapTrack(t0, r); const ax = outX, ay = outY;
      mapTrack(t1, r);
      surface.lineXY(ax, ay, outX, outY, cr, cg, cb, power);
      if (i < 22) {
        const ph0 = i * .55 - motion * 2.6 + lane, ph1 = (i - 1) * .55 - motion * 2.6 + lane;
        palette(phase + lane * .15 + .22, colorScratch);
        whiten(colorScratch, .25);
        const hr = colorScratch[0], hg = colorScratch[1], hb = colorScratch[2];
        mapTrack(t0, r + Math.sin(ph0) * .028, Math.cos(ph0) * .048); const hx = outX, hy = outY;
        mapTrack(t1, r + Math.sin(ph1) * .028, Math.cos(ph1) * .048);
        surface.lineXY(hx, hy, outX, outY, hr, hg, hb, power * .68);
      }
    }
    palette(phase + lane * .15, colorScratch);
    whiten(colorScratch, .94);
    mapTrack(head + .0043, r);
    surface.flareXY(outX, outY, colorScratch[0], colorScratch[1], colorScratch[2], 1.85);
  }

  // 6. Reactive Ambient HUD: live task progress gauge arc & synchronized lead beacon.
  if (pulse) {
    const prog = clamp(pulse.progress, 0, 1);
    const arcSteps = Math.max(8, Math.round(steps * prog));
    if (prog > 0.005) {
      palette(phase + .12, colorScratch);
      whiten(colorScratch, .62);
      drawTrackPath(arcSteps, 0, prog, 1.14, .055, colorScratch[0], colorScratch[1], colorScratch[2], 1.55);
    }
    palette(phase + prog * .6, colorScratch);
    whiten(colorScratch, .96);
    mapTrack(prog, 1.14, .055);
    surface.flareXY(outX, outY, colorScratch[0], colorScratch[1], colorScratch[2], 2.25);
  }

  return surface.render(color, opacity, rowSkips);
}

export function spiralArt(
  width: number,
  height: number,
  motion: number,
  color: boolean,
  palette: PaletteWriter,
  colorMotion: number,
  opacity = 100,
  rowSkips?: ArrayLike<number>,
  pulse?: TaskPulse,
): string[] {
  const [w, h] = dimensions(width, height);
  if (!w || !h) return [];
  const surface = surfaceFor(w, h);
  const urgency = pulse ? (pulse.committing ? 1 : clamp(1 - pulse.countdownSec / 60, 0, 1)) : 0;
  const scale = Math.max(Math.min(surface.w, surface.h) * .5, Math.min(surface.w * .41, surface.h * .66)), phase = -colorMotion * .025;
  const originX = surface.w * (w >= 96 ? .54 : .5), originY = surface.h * .5;
  let outX = 0, outY = 0;
  const map = (depth: number, angle: number) => {
    const radius = 1.34 * Math.exp(-depth * .17), twist = angle + depth * .64 + motion * (.34 + urgency * .16);
    const damp = Math.exp(-depth * .1);
    const bendX = Math.sin(depth * .48 + motion * .24) * .13 * damp;
    const bendY = Math.cos(depth * .38 + motion * .17) * .1 * damp;
    const ripple = 1 + (.055 + urgency * .025) * Math.sin(angle * 6 + depth * .62 - motion * (.78 + urgency * .45)) + .026 * Math.cos(angle * 3 - depth * .45 + motion * .52);
    outX = originX + (Math.cos(twist) * radius * ripple + bendX) * scale;
    outY = originY + (Math.sin(twist) * radius * ripple + bendY) * scale;
  };

  // Fine receding mandala rings cross twisted filaments into the pupil.
  for (let ring = 0; ring < 28; ring++) {
    const depth = ring * .68;
    const power = (.34 + .38 * Math.exp(-ring * .06)) * (ring % 3 === 0 ? 1.12 : .64);
    palette(phase + depth * .058, colorScratch);
    const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
    const nSteps = Math.max(72, Math.round(290 * Math.exp(-depth * .1))), inv = (Math.PI * 2) / nSteps;
    map(depth, 0);
    let prevX = outX, prevY = outY;
    for (let i = 1; i <= nSteps; i++) {
      map(depth, i * inv);
      surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, power);
      prevX = outX; prevY = outY;
    }
  }

  for (let arm = 0; arm < 14; arm++) {
    const angle = (arm / 14) * Math.PI * 2;
    const wAmt = .18 + .28 * Math.max(0, Math.cos(angle + motion * .34));
    for (let segment = 0; segment < 36; segment++) {
      const depth = segment * .52;
      palette(phase + arm * .038 + depth * .042, colorScratch);
      whiten(colorScratch, wAmt);
      const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
      const pwr = (.74 + .44 * Math.max(0, Math.cos(angle + depth * .64 + motion * .34))) * Math.exp(-depth * .022);
      map(depth, angle);
      let prevX = outX, prevY = outY;
      for (let i = 1; i <= 8; i++) {
        map(depth + (i / 8) * .52, angle);
        surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, pwr);
        prevX = outX; prevY = outY;
      }
    }
    if (arm % 2 === 0) {
      for (let segment = 0; segment < 24; segment++) {
        const d0 = segment * .72, d1 = (segment + 1) * .72;
        const a0 = angle - d0 * .85 - motion * .42, a1 = angle - d1 * .85 - motion * .42;
        palette(phase + .42 + arm * .04 + d0 * .035, colorScratch);
        const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
        map(d0, a0); const ax = outX, ay = outY;
        map(d1, a1);
        surface.lineXY(ax, ay, outX, outY, cr, cg, cb, .42 * Math.exp(-d0 * .038));
      }
    }
    const depth = ((motion * (2.35 + urgency * .85) + arm * 1.37) % 17 + 17) % 17;
    palette(phase + arm * .038 + depth * .042, colorScratch);
    whiten(colorScratch, .86);
    const fr = colorScratch[0], fg = colorScratch[1], fb = colorScratch[2];
    map(depth, angle);
    let prevX = outX, prevY = outY;
    for (let i = 0; i < 8; i++) {
      map(depth - (i + 1) * .062, angle);
      surface.lineXY(prevX, prevY, outX, outY, fr, fg, fb, 1.65 * (1 - i / 9));
      prevX = outX; prevY = outY;
    }
    if (arm % 2 === 0) {
      palette(phase + depth * .042, colorScratch);
      whiten(colorScratch, .92);
      map(depth, angle);
      surface.flareXY(outX, outY, colorScratch[0], colorScratch[1], colorScratch[2], 1.45);
    }
  }

  if (pulse) {
    const pDepth = (1 - clamp(pulse.progress, 0, 1)) * 13.5;
    palette(phase + .2, colorScratch);
    whiten(colorScratch, .78);
    const cr = colorScratch[0], cg = colorScratch[1], cb = colorScratch[2];
    const nSteps = 96, inv = (Math.PI * 2) / nSteps;
    map(pDepth, 0);
    let prevX = outX, prevY = outY;
    for (let i = 1; i <= nSteps; i++) {
      map(pDepth, i * inv);
      surface.lineXY(prevX, prevY, outX, outY, cr, cg, cb, 1.5);
      prevX = outX; prevY = outY;
    }
    map(pDepth, motion * .8);
    surface.flareXY(outX, outY, cr, cg, cb, 2.1);
    map(pDepth, motion * .8 + Math.PI);
    surface.flareXY(outX, outY, cr, cg, cb, 2.1);
  }

  return surface.render(color, opacity, rowSkips);
}

/**
 * 在终端右侧子像素画布上渲染真实 GPS 轨迹的发光投影（含配速色相渐变、起终点星芒与动态跑者光点）。
 */
export function routeMinimapArt(
  points: readonly MinimapPoint[],
  width: number,
  height: number,
  motion: number,
  color: boolean,
  palette: PaletteWriter,
  colorMotion: number,
  opacity = 100,
  rowSkips?: ArrayLike<number>,
): string[] {
  const [w, h] = dimensions(width, height);
  if (!w || !h || points.length < 2) return [];
  const surface = surfaceFor(w, h);
  let maxSkip = 0;
  if (rowSkips) {
    for (let y = 0; y < h; y++) {
      const sk = rowSkips[y] ?? 0;
      if (sk < w && sk > maxSkip) maxSkip = sk;
    }
  }
  const freeCols = w - maxSkip >= 24 ? w - maxSkip : w;
  const leftPx = w - maxSkip >= 24 ? maxSkip * 2 : 0;
  const regionW = freeCols * 2;
  const regionH = surface.h;
  const span = Math.max(8, Math.min(regionW * 0.80, regionH * 0.78));
  const cx = leftPx + regionW * 0.5;
  const cy = regionH * 0.5;
  const x0 = cx - span * 0.5, y0 = cy - span * 0.5;
  const x1 = cx + span * 0.5, y1 = cy + span * 0.5;
  const phase = -colorMotion * 0.025;

  // 1. Subtle holographic HUD frame brackets & center reticle.
  palette(phase + 0.5, colorScratch);
  const br = colorScratch[0], bg = colorScratch[1], bb = colorScratch[2];
  const corner = Math.max(4, span * 0.11), padFrame = Math.max(3, span * 0.08);
  const fx0 = x0 - padFrame, fy0 = y0 - padFrame, fx1 = x1 + padFrame, fy1 = y1 + padFrame;
  surface.lineXY(fx0, fy0, fx0 + corner, fy0, br, bg, bb, 0.42);
  surface.lineXY(fx0, fy0, fx0, fy0 + corner, br, bg, bb, 0.42);
  surface.lineXY(fx1, fy0, fx1 - corner, fy0, br, bg, bb, 0.42);
  surface.lineXY(fx1, fy0, fx1, fy0 + corner, br, bg, bb, 0.42);
  surface.lineXY(fx0, fy1, fx0 + corner, fy1, br, bg, bb, 0.42);
  surface.lineXY(fx0, fy1, fx0, fy1 - corner, br, bg, bb, 0.42);
  surface.lineXY(fx1, fy1, fx1 - corner, fy1, br, bg, bb, 0.42);
  surface.lineXY(fx1, fy1, fx1, fy1 - corner, br, bg, bb, 0.42);
  surface.lineXY(cx - 3, cy, cx + 3, cy, br, bg, bb, 0.22);
  surface.lineXY(cx, cy - 3, cx, cy + 3, br, bg, bb, 0.22);

  // 2. Ambient shadow ribbon slightly below path for 3D depth.
  const n = points.length;
  palette(phase + 0.72, colorScratch);
  const sr = colorScratch[0], sg = colorScratch[1], sb = colorScratch[2];
  for (let i = 1; i < n; i++) {
    const a = points[i - 1]!, b = points[i]!;
    surface.lineXY(x0 + a[0] * span, y0 + a[1] * span + 1.8, x0 + b[0] * span, y0 + b[1] * span + 1.8, sr, sg, sb, 0.26);
  }

  // 3. Main GPS trajectory colored by pace/progress.
  for (let i = 1; i < n; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const colorPos = phase + b[2] * 0.55 + (i / n) * 0.35;
    palette(colorPos, colorScratch);
    whiten(colorScratch, 0.14);
    surface.lineXY(
      x0 + a[0] * span,
      y0 + a[1] * span,
      x0 + b[0] * span,
      y0 + b[1] * span,
      colorScratch[0],
      colorScratch[1],
      colorScratch[2],
      0.98,
    );
  }

  // 4. Start & finish anchor flares.
  const startPt = points[0]!, endPt = points[n - 1]!;
  palette(phase + 0.15, colorScratch);
  whiten(colorScratch, 0.65);
  surface.flareXY(x0 + startPt[0] * span, y0 + startPt[1] * span, colorScratch[0], colorScratch[1], colorScratch[2], 1.35);
  palette(phase + 0.85, colorScratch);
  whiten(colorScratch, 0.82);
  surface.flareXY(x0 + endPt[0] * span, y0 + endPt[1] * span, colorScratch[0], colorScratch[1], colorScratch[2], 1.55);

  // 5. Animated plasma runner comet tracing along the actual GPS polyline.
  const cycle = (((motion * 0.22) % 1) + 1) % 1;
  const headPos = cycle * (n - 1);
  const trailLen = Math.min(20, Math.max(4, Math.round(n * 0.12)));
  for (let k = trailLen; k >= 1; k--) {
    const p1 = headPos - (k - 1) * 0.75;
    const p0 = headPos - k * 0.75;
    if (p1 <= 0) continue;
    const idx0 = Math.max(0, Math.min(n - 1, Math.floor(p0)));
    const idx1 = Math.max(0, Math.min(n - 1, Math.ceil(p1)));
    const a = points[idx0]!, b = points[idx1]!;
    const fade = 1 - k / (trailLen + 1);
    palette(phase + cycle * 0.6, colorScratch);
    whiten(colorScratch, fade * 0.82);
    surface.lineXY(
      x0 + a[0] * span,
      y0 + a[1] * span,
      x0 + b[0] * span,
      y0 + b[1] * span,
      colorScratch[0],
      colorScratch[1],
      colorScratch[2],
      1.7 * fade,
    );
  }
  const hi = Math.min(n - 2, Math.max(0, Math.floor(headPos)));
  const frac = headPos - hi;
  const ha = points[hi]!, hb = points[hi + 1]!;
  const hx = x0 + (ha[0] + (hb[0] - ha[0]) * frac) * span;
  const hy = y0 + (ha[1] + (hb[1] - ha[1]) * frac) * span;
  palette(phase + cycle * 0.6, colorScratch);
  whiten(colorScratch, 0.94);
  surface.flareXY(hx, hy, colorScratch[0], colorScratch[1], colorScratch[2], 2.0);

  return surface.render(color, opacity, rowSkips);
}
