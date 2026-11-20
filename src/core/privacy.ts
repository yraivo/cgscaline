function displayCells(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff01 && code <= 0xff60) ||
      code >= 0x1f000 ? 2 : 1;
  }
  return w;
}

/** Mask personal identifiers (xh, nickname, schoolId, device IDs, sportId) into asterisks. */
export function maskText(value: string, min = 4, max = 12): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—" || trimmed === "未选择") return value;
  const len = Math.max(min, Math.min(max, displayCells(trimmed)));
  return "*".repeat(len);
}

export function maskFixed(value: string, length = 12): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—") return value;
  return "*".repeat(Math.max(4, Math.min(length, trimmed.length)));
}

export function maskProxyLabel(label: string): string {
  if (!label || label === "直连" || label === "已配置代理") return label;
  const idx = label.indexOf("//");
  if (idx >= 0) return `${label.slice(0, idx + 2)}********`;
  return "********";
}
