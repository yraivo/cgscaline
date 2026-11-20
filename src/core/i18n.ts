import type { LogoFont, VisualStyle } from './model.js';

export type Language = 'zh' | 'en';
export const languages = Object.freeze(['zh', 'en'] as const);
export const resolveLanguage = (value: unknown): Language => (value === 'en' ? 'en' : 'zh');

export const languageNames: Readonly<Record<Language, string>> = Object.freeze({
  zh: '中文',
  en: 'English',
});

export const tr = (lang: Language | undefined, zh: string, en: string): string =>
  lang === 'en' ? en : zh;

export function cliLanguage(args: readonly string[]): Language | undefined {
  if (args.includes('--en') || args.includes('--english')) return 'en';
  if (args.includes('--zh') || args.includes('--chinese')) return 'zh';
  const idx = args.indexOf('--lang');
  if (idx >= 0 && args[idx + 1]) {
    const v = args[idx + 1]!.toLowerCase();
    if (v.startsWith('en')) return 'en';
    if (v.startsWith('zh') || v.startsWith('cn')) return 'zh';
  }
  const eq = args.find(a => a.startsWith('--lang='));
  if (eq) {
    const v = eq.slice('--lang='.length).toLowerCase();
    if (v.startsWith('en')) return 'en';
    if (v.startsWith('zh') || v.startsWith('cn')) return 'zh';
  }
  return undefined;
}

export function visualStyleLabel(style: VisualStyle, lang?: Language): string {
  if (lang === 'en') {
    return style === 'track' ? 'Luminous Track' : style === 'spiral' ? 'Spiral Field' : 'Off';
  }
  return style === 'track' ? '光轨跑道' : style === 'spiral' ? '螺旋' : '关闭';
}

export function fontLabel(font: LogoFont, lang?: Language): string {
  if (font === 'plain') return lang === 'en' ? 'Plain Text' : '纯文字';
  return 'The Edge';
}

const exactBackendMap: Readonly<Record<string, string>> = {
  '未发现更新': 'Up to date',
  '需要更新客户端': 'Client update required',
  '发现新版本，需要更新': 'New app version detected — update required',
  '无法识别更新信息': 'Unrecognized version response',
  '请填写学校 ID': 'Enter Campus ID first',
  '暂不支持此 App 版本': 'Unsupported App version',
  '更新检查失败': 'Version probe failed',
  '更新检查连接失败': 'Version probe connection failed',
  '请先检查更新。': 'Run version probe (C) first.',
  '登录信息已失效，请重新登录。': 'Session expired; please sign in again.',
  '登录续期失败。': 'Token renewal failed.',
  '连接失败或超时。': 'Connection failed or timed out.',
  '代理地址格式错误。': 'Invalid proxy URL format.',
  '代理仅支持 HTTP(S) / SOCKS5 地址。': 'Proxy must be an HTTP(S) or SOCKS5 URL.',
  '请求目标不在服务白名单。': 'Target host is not in the service allowlist.',
  '请间隔 60 秒再登录。': 'Please wait 60s between login attempts.',
  '请间隔 60 秒再刷新概览。': 'Overview cooldown: wait 60s before refreshing.',
  '请间隔 60 秒再刷新学校资料。': 'Venue rules cooldown: wait 60s before refreshing.',
  '请间隔 30 秒再刷新学校通知。': 'Notices cooldown: wait 30s before refreshing.',
  '任务进行中，请先暂停再查记录。': 'Task active — pause before syncing workout log.',
  '任务进行中，请先暂停再查询。': 'Task active — pause before querying.',
  '先处理未结束任务，再修改学校配置。': 'Finish or archive active tasks before editing campus config.',
  '账号有未处理任务或请求，不能更改档案。': 'Account has active tasks or requests; cannot modify profile.',
  '该服务的账号已存在，请进入已有档案。': 'Account already exists for this campus service.',
  '已达到最大并发数量，请加入执行计划或稍后再试。': 'Max concurrency reached — schedule or wait for an active slot.',
  '记录范围无效。': 'Invalid record scope.',
  '密码不能为空。': 'Password cannot be empty.',
  '备份包解密失败：口令错误或文件已损坏。': 'Vault decryption failed: wrong passphrase or corrupted file.',
};

export function localizeBackendText(text: string, lang?: Language): string {
  if (lang !== 'en' || !text) return text;
  const direct = exactBackendMap[text];
  if (direct) return direct;
  return text
    .replace(/^登录未成功（HTTP (.+)，业务码 (.+)）。$/, 'Sign-in failed (HTTP $1, code $2).')
    .replace(/^查询未成功（HTTP (.+)，业务码 (.+)）。$/, 'Query failed (HTTP $1, code $2).')
    .replace(/^(.+) 尚未配置记录库，请在账号管理中导入。$/, '$1 has no track library bound — import one in Account Settings.');
}
