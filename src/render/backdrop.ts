const colors = new Map<string, string>();
/** Dim generated artwork toward the terminal canvas; text is composited separately. */
export function dimArtwork(row: string, opacity = 35) {
  const ratio = Math.max(0.1, Math.min(1, opacity / 100));
  const fgAmount = +(ratio * 0.95).toFixed(3), bgAmount = +(ratio * 0.65).toFixed(3);
  return row.replace(/\x1b\[(38|48);2;(\d+);(\d+);(\d+)m/g, (code, kind, r, g, b) => {
    const key = `${opacity}:${code}`, old = colors.get(key);
    if (old) return old;
    const amount = kind === '38' ? fgAmount : bgAmount, base = [14, 4, 29];
    const rgb = [+r, +g, +b].map((value, i) => Math.round(base[i]! + (value - base[i]!) * amount));
    const result = `\x1b[${kind};2;${rgb.join(';')}m`;
    colors.set(key, result);
    if (colors.size > 1024) colors.delete(colors.keys().next().value!);
    return result;
  });
}
/** Artwork uses single-cell ASCII/Braille glyphs. Preserve colors at the cut position. */
export function artworkTail(row: string, skip: number) {
  if (skip <= 0) return row;
  let used = 0, foreground = '', background = '', out = '', started = false;
  for (const token of row.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g) ?? []) {
    if (token.startsWith('\x1b[')) {
      if (token.startsWith('\x1b[38;')) foreground = token;
      if (token.startsWith('\x1b[48;')) background = token;
      if (started) out += token;
      continue;
    }
    if (!started) {
      if (used + token.length <= skip) { used += token.length; continue; }
      out += background + foreground + token.slice(skip - used);
      started = true;
    } else out += token;
  }
  return out;
}
