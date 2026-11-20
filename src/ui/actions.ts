import type { AccountView } from "../app/contracts.js";
import { safeText, type Language } from "../core/model.js";
import { maskProxyLabel } from "../core/privacy.js";
export const ext = (v: unknown) => safeText(v, 900);

export const accountActions = ["开始一次", "我的记录", "账号概览", "账号设置"];
export const accountActionsEn = ["Start One-Shot", "Workout Log", "Account Overview", "Account Settings"];

export const manageActions = [
  "登录 / 更新会话",
  "默认路线",
  "记录库（导入 / 选择）",
  "设备标识",
  "代理",
  "修改昵称",
  "清除本地会话",
  "切换学校",
  "删除账号",
  "返回",
];
export const manageActionsEn = [
  "Sign In / Refresh Session",
  "Default Route",
  "Track Library (Import / Select)",
  "Device Fingerprint",
  "Outbound Proxy",
  "Edit Alias",
  "Clear Local Session",
  "Switch Campus",
  "Delete Account",
  "Back",
];

export const settingActions = [
  "学校配置",
  "并发上限",
  "记录库",
  "外观",
  "完成与异常通知",
  "学期目标次数",
  "导出加密备份包",
  "导入加密备份包",
  "停止后台并退出",
  "返回",
];
export const settingActionsEn = [
  "Campus Config",
  "Max Concurrency",
  "Track Libraries",
  "Appearance & Language",
  "System Notifications",
  "Semester Target Runs",
  "Export Encrypted Vault (.cgsbak)",
  "Import Encrypted Vault (.cgsbak)",
  "Stop Daemon & Exit",
  "Back",
];

export const appearanceActions = [
  "配色",
  "字标",
  "图形",
  "背景亮度",
  "渐变速度",
  "动画帧率",
  "动画",
  "语言",
];
export const appearanceActionsEn = [
  "Palette",
  "Wordmark",
  "Backdrop",
  "Backdrop Opacity",
  "Chroma Speed",
  "Frame Rate",
  "Motion",
  "Language",
];

export const moreActions = [
  ["a", "添加账号"],
  ["i", "账号概览"],
  ["m", "账号设置"],
  ["l", "记录库"],
  ["r", "学校资料"],
  ["u", "外观"],
  ["n", "学校通知"],
  ["g", "全局设置"],
] as const;

export const moreActionsEn = [
  ["a", "Add Account"],
  ["i", "Account Overview"],
  ["m", "Account Settings"],
  ["l", "Track Libraries"],
  ["r", "Venue Rules"],
  ["u", "Appearance"],
  ["n", "Campus Notices"],
  ["g", "Global Settings"],
] as const;

export const getAccountActions = (lang: Language = "zh") =>
  lang === "en" ? accountActionsEn : accountActions;
export const getManageActions = (lang: Language = "zh") =>
  lang === "en" ? manageActionsEn : manageActions;
export const getSettingActions = (lang: Language = "zh") =>
  lang === "en" ? settingActionsEn : settingActions;
export const getAppearanceActions = (lang: Language = "zh") =>
  lang === "en" ? appearanceActionsEn : appearanceActions;
export const getMoreActions = (lang: Language = "zh") =>
  lang === "en" ? moreActionsEn : moreActions;

export function networkLabel(a: AccountView, privacy = false, lang: Language = "zh") {
  if (!a.proxy) return lang === "en" ? "Direct" : "直连";
  try {
    const u = new URL(a.proxy);
    const raw = `${u.protocol}//${u.host}`;
    return privacy ? maskProxyLabel(raw) : raw;
  } catch {
    return lang === "en" ? "Proxy Set" : "已配置代理";
  }
}
