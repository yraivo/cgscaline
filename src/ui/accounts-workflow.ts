import type { AccountView } from "../app/contracts.js";
import { deviceConflicts } from "../core/device-identity.js";
import {
  deviceFromPreset,
  devicePresetKeys,
  devicePresetNames,
  deviceProfiles,
  type DevicePreset,
} from "../core/device-profiles.js";
import { resolveLanguage, tr } from "../core/i18n.js";
import { canUseLibrary as canUse, deviceHeaders, UserError } from "../core/model.js";
import { maskFixed, maskText } from "../core/privacy.js";
import { searchSchools, type SchoolDirectoryEntry } from "../campus/school-directory.js";
import { resolveCampusLabel } from "./pages.js";

import type { UIController } from "./controller.js";
export class AccountWorkflow {
  constructor(private ui: UIController) {}

  private get lang() {
    return resolveLanguage(this.ui.app.state.settings.language);
  }

  async chooseSchool(allowReuse = true): Promise<SchoolDirectoryEntry> {
    const lang = this.lang;
    const existing = this.ui.app.state.accounts.find((x) => x.school.name && x.school.id)?.school;
    let query = "";
    if (allowReuse && existing?.name) {
      query = await this.ui.ask(
        tr(lang, "选择学校", "SELECT CAMPUS"),
        tr(
          lang,
          `回车直接沿用「${existing.name}」，或输入其他学校名称 / 缩写搜索`,
          `Press Enter to keep "${existing.nameEn ?? existing.name}", or search another school`,
        ),
        "",
      );
      if (!query.trim()) {
        return {
          id: existing.id,
          name: existing.name,
          nameEn: existing.nameEn ?? existing.name,
          code: existing.code ?? "",
          provinceCode: existing.provinceCode,
          randomCode: existing.randomCode,
          baseUrl: existing.baseUrl,
        };
      }
    }
    const schools = await this.ui.app.commands.listSchools();
    if (!query.trim()) {
      query = await this.ui.ask(
        tr(lang, "选择学校", "SELECT CAMPUS"),
        tr(
          lang,
          `输入学校名称、简称或代码（共支持 ${schools.length} 所高校）`,
          `Search school name or code (${schools.length} supported campuses)`,
        ),
      );
    }
    const matches = searchSchools(schools, query);
    if (!matches.length) {
      throw new UserError(
        tr(lang, "未找到匹配的学校，请换个关键词重试。", "No matching campus found; try another keyword."),
      );
    }
    if (matches.length === 1) return matches[0]!;
    const exact = matches[0]!;
    const qLower = query.trim().toLowerCase();
    if (
      exact.name.toLowerCase() === qLower ||
      exact.code.toLowerCase() === qLower ||
      exact.id.toLowerCase() === qLower
    ) {
      return exact;
    }
    const top = matches.slice(0, 8);
    const pick = await this.ui.ask(
      tr(lang, "匹配到多所学校", "SELECT MATCHING CAMPUS"),
      top
        .map((s, i) => `${i + 1}:${lang === "en" ? s.nameEn || s.name : s.name}`)
        .join(" / "),
      "1",
    );
    const chosen = top[Number(pick) - 1];
    if (!chosen) {
      throw new UserError(tr(lang, "学校序号选择无效。", "Invalid campus selection."));
    }
    return chosen;
  }

  async add() {
    const lang = this.lang;
    const school = await this.chooseSchool(true);
    const campusLabel = lang === "en" ? school.nameEn || school.name : school.name;
    const username = await this.ui.ask(
      `${tr(lang, "添加账号", "ADD ACCOUNT")} · ${campusLabel}`,
      tr(lang, "学号", "User / Student ID"),
    );
    const label = await this.ui.ask(
      tr(lang, "添加账号", "ADD ACCOUNT"),
      tr(lang, "昵称（回车直接使用学号）", "Alias (Enter to use Student ID)"),
      username,
    );
    const preset = await this.chooseDevicePreset(true);
    const a = await this.ui.app.commands.addAccount(
      label,
      username,
      school,
      preset,
    );
    this.ui.view.accountId = a.id;
    this.ui.navigate("manage");
    this.ui.view.notice =
      lang === "en"
        ? `Added ${campusLabel} account · press Enter to sign in`
        : `已添加「${campusLabel}」账号 · 按回车即可登录`;
  }

  async accountAction() {
    const a = this.ui.current();
    const lang = this.lang;
    if (this.ui.view.selected === 0) {
      if (deviceConflicts(a, this.ui.app.state.accounts).length) {
        this.ui.navigate("manage");
        this.ui.view.selected = 3;
        this.ui.view.notice = tr(
          lang,
          "设备标识重复，请在设置中更换。",
          "Duplicate device ID detected; regenerate in settings.",
        );
        return;
      }
      if (!a.session || a.session.status === "invalid") await this.login(a);
      else await this.ui.shots.oneShot(a);
    } else if (this.ui.view.selected === 1) {
      const cache = await this.ui.app.commands.loadCachedRecords(a.id);
      this.ui.navigate("history");
      this.ui.view.historyScope = "current";
      this.ui.view.history = cache?.records;
      this.ui.view.historyFetchedAt = cache?.fetchedAt;
    } else if (this.ui.view.selected === 2)
      await this.ui.showInformation("account");
    else this.ui.navigate("manage");
  }

  async login(a: AccountView) {
    const lang = this.lang;
    await this.ui.app.commands.ensureCompatible(a.id);
    const isCas = a.school.loginType === "3";
    let password = await this.ui.ask(
      tr(lang, "登录", "SIGN IN"),
      isCas
        ? tr(
            lang,
            "密码或 5 段 CAS Token（统一认证高校也可在记录库按 P/I 从手机备份自动带入登录态）",
            "Password or 5-part CAS Token (or import phone backup via P/I to auto-sync session)",
          )
        : tr(lang, "密码", "Password (never stored on disk)"),
      "",
      true,
    );
    try {
      await this.ui.app.commands.login(a.id, password);
      this.ui.navigate("account");
      this.ui.view.notice = tr(lang, "登录成功。", "Session established.");
    } finally {
      password = "";
    }
  }

  async manageAction() {
    const a = this.ui.current();
    const lang = this.lang;
    switch (this.ui.view.selected) {
      case 0:
        return this.login(a);
      case 1: {
        const rules = a.information?.rules.data ?? [];
        const hint = rules.length
          ? rules.map((r) => `${r.id}:${r.name}`).join(" / ")
          : tr(lang, "输入路线 ID（登录后可自动显示本校全部路线）", "Enter route ID (sign in first to list campus routes)");
        const routeId = await this.ui.ask(
          tr(lang, "默认路线", "DEFAULT ROUTE"),
          hint,
          a.routeId,
        );
        if (!/^[0-9]{1,8}$/.test(routeId))
          throw new UserError(tr(lang, "路线 ID 格式不正确。", "Invalid route ID format."));
        await this.ui.app.commands.configure(a.id, { routeId });
        const matchedName = rules.find((r) => r.id === routeId)?.name;
        this.ui.view.notice = matchedName
          ? tr(lang, `默认路线已设为 ${routeId}（${matchedName}）。`, `Default route set to ${routeId} (${matchedName}).`)
          : tr(lang, "默认路线已保存。", "Default route saved.");
        return;
      }
      case 2: {
        const rawMode = (
          await this.ui.ask(
            tr(lang, "记录来源", "TRACK SOURCE"),
            tr(
              lang,
              "private 私人 / public 本机共享（也可输入 1 或 2）",
              "private (personal) / public (local shared) — or enter 1 / 2",
            ),
            a.sourceMode,
          )
        ).trim().toLowerCase();
        const mode =
          rawMode === "private" || rawMode === "私人" || rawMode === "1"
            ? "private"
            : rawMode === "public" || rawMode === "共享" || rawMode === "本机共享" || rawMode === "2"
              ? "public"
              : undefined;
        if (!mode)
          throw new UserError(tr(lang, "请输入 private（私人）或 public（本机共享）。", "Enter private or public."));
        let libs = this.ui.app.state.libraries.filter((l) =>
          canUse(l, { ...a, sourceMode: mode }),
        );
        if (!libs.length) {
          await this.import();
          libs = this.ui.app.state.libraries.filter((l) =>
            canUse(l, { ...a, sourceMode: mode }),
          );
        }
        if (!libs.length) throw new UserError(tr(lang, "没有该范围下的可用库。", "No compatible library in scope."));
        const n =
          libs.length === 1
            ? 1
            : Number(
                await this.ui.ask(
                  tr(lang, "记录库", "SELECT LIBRARY"),
                  libs.map((l, i) => `${i + 1}:${l.label}`).join(" / "),
                  "1",
                ),
              );
        if (!libs[n - 1]) throw new UserError(tr(lang, "记录库选择无效。", "Invalid library selection."));
        await this.ui.app.commands.configure(a.id, {
          sourceMode: mode,
          libraryId: libs[n - 1]!.id,
        });
        this.ui.view.notice = tr(lang, "记录库已保存。", "Track library bound.");
        return;
      }
      case 3:
        return this.configure(a);
      case 4: {
        const proxy = await this.ui.ask(
          tr(lang, "账号代理", "OUTBOUND PROXY"),
          tr(
            lang,
            "HTTP(S) / SOCKS5 URL，例如 socks5://127.0.0.1:1081；留空直连，Ctrl+U 清空。",
            "HTTP(S) / SOCKS5 URL, e.g. socks5://127.0.0.1:1081; blank for direct, Ctrl+U clears.",
          ),
          a.proxy,
          Boolean(this.ui.app.state.settings.privacyMode),
        );
        await this.ui.app.commands.configure(a.id, { proxy });
        this.ui.view.notice =
          this.ui.account(a.id).session?.status === "invalid"
            ? tr(lang, "代理已保存，请重新登录。", "Proxy saved; sign in again.")
            : tr(lang, "代理已保存。", "Proxy saved.");
        return;
      }
      case 5: {
        const label = await this.ui.ask(
          tr(lang, "昵称", "ALIAS"),
          tr(lang, "新的账号昵称", "New display alias"),
          a.label,
        );
        if (!label) throw new UserError(tr(lang, "昵称不能为空。", "Alias cannot be empty."));
        await this.ui.app.commands.configure(a.id, { label });
        return;
      }
      case 6:
        await this.ui.confirm(
          tr(lang, "清除本地会话", "CLEAR SESSION"),
          tr(lang, "清除当前账号的登录信息？", "Purge saved session tokens for this account?"),
        );
        await this.ui.app.commands.clearSession(a.id);
        return;
      case 7: {
        const picked = await this.chooseSchool(false);
        await this.ui.app.commands.configure(a.id, {
          school: {
            id: picked.id,
            provinceCode: picked.provinceCode,
            randomCode: picked.randomCode,
            baseUrl: picked.baseUrl,
            name: picked.name,
            nameEn: picked.nameEn,
            code: picked.code,
            ...(picked.loginType ? { loginType: picked.loginType } : {}),
            ...(picked.loginUrl ? { loginUrl: picked.loginUrl } : {}),
          },
        });
        const shown = lang === "en" ? picked.nameEn || picked.name : picked.name;
        this.ui.view.notice = tr(
          lang,
          `已切换为「${shown}」，请重新登录。`,
          `Switched campus to ${shown}; please sign in again.`,
        );
        return;
      }
      case 8: {
        const maskedUser = this.ui.app.state.settings.privacyMode ? maskText(a.username) : a.username;
        await this.ui.confirm(
          tr(lang, "删除账号", "DELETE ACCOUNT"),
          lang === "en"
            ? `Delete ${maskedUser} along with its private libraries and task history?`
            : `删除 ${maskedUser} 及其私人记录库和任务历史？`,
        );
        await this.ui.app.commands.deleteAccount(a.id);
        this.ui.view.marked = this.ui.view.marked?.filter((id) => id !== a.id);
        this.ui.home();
        this.ui.view.notice = tr(lang, "账号已删除。", "Account deleted.");
        return;
      }
      default:
        this.ui.navigate("account");
    }
  }

  async configure(a: AccountView) {
    const lang = this.lang;
    if (this.ui.hasTask(a.id))
      throw new UserError(tr(lang, "账号有未结束任务，请先处理。", "Finish or archive active tasks first."));
    const priv = !!this.ui.app.state.settings.privacyMode;
    const aid = priv ? maskFixed(a.device.androidId, 16) : a.device.androidId;
    const imei = priv ? maskFixed(deviceHeaders(a.device).imei, 16) : deviceHeaders(a.device).imei;
    const action = await this.ui.ask(
      tr(lang, "独立设备档案", "DEVICE FINGERPRINT"),
      lang === "en"
        ? `Android ID: ${aid} / imei: ${imei}. Type preset / new / edit, or blank to cancel.`
        : `Android ID：${aid} / imei：${imei}。preset 选择整套预设；new 换标识；edit 手动修改；留空返回。`,
      "",
    );
    if (!action) return;
    if (action.toLowerCase() === "new") {
      await this.ui.confirm(
        tr(lang, "更换本账号设备标识", "ROTATE DEVICE ID"),
        tr(lang, "更换设备标识后需要重新登录。更换？", "Rotating device ID invalidates the current session. Proceed?"),
      );
      const next = await this.ui.app.commands.regenerateDevice(a.id);
      this.ui.view.notice =
        lang === "en"
          ? `New device ID saved (${next.imei}); please sign in again.`
          : `设备标识已保存：${next.imei}。请重新登录。`;
      return;
    }
    if (action.toLowerCase() === "preset") {
      const key = await this.chooseDevicePreset(false),
        d = deviceFromPreset(key as DevicePreset, a.device.androidId);
      if (
        Object.entries(d).every(
          ([field, value]) => a.device[field as keyof typeof d] === value,
        )
      ) {
        this.ui.view.notice = tr(lang, "已在使用此设备预设。", "Already using this preset.");
        return;
      }
      await this.ui.confirm(
        tr(lang, "更换设备档案", "APPLY PRESET"),
        `${d.manufacturer} ${d.model} / Android ${d.androidRelease} / SDK ${d.sdk} / ${d.buildId} — ${tr(lang, "保存后需要重新登录，继续？", "re-login required. Apply?")}`,
      );
      await this.ui.app.commands.configure(a.id, { device: d });
      this.ui.view.notice = tr(lang, "设备已保存，请重新登录。", "Device profile updated; sign in again.");
      return;
    }
    if (action.toLowerCase() !== "edit")
      throw new UserError(tr(lang, "请输入 preset、new、edit 或直接返回。", "Enter preset, new, edit, or leave blank."));
    const d = structuredClone(a.device);
    d.androidId = await this.ui.ask("DEVICE", tr(lang, "Android ID（16 位十六进制）", "Android ID (16 hex chars)"), d.androidId);
    d.manufacturer = await this.ui.ask("DEVICE", tr(lang, "厂商 manufacturer", "Manufacturer"), d.manufacturer);
    d.model = await this.ui.ask("DEVICE", tr(lang, "型号 model", "Model"), d.model);
    d.androidRelease = await this.ui.ask("DEVICE", "Android release", d.androidRelease);
    d.sdk = await this.ui.ask("DEVICE", "Android SDK", d.sdk);
    d.buildId = await this.ui.ask("DEVICE", "Build ID", d.buildId);
    await this.ui.confirm(
      "SAVE PROFILE",
      `imei=${deviceHeaders(d).imei} — ${tr(lang, "保存后需要重新登录，继续？", "re-login required. Save?")}`,
    );
    await this.ui.app.commands.configure(a.id, { device: d });
    this.ui.view.notice = tr(lang, "设备已保存。", "Device profile saved.");
  }

  async chooseDevicePreset(automatic: boolean): Promise<DevicePreset | "auto"> {
    const lang = this.lang;
    const brands = [
      ...new Set(
        devicePresetKeys.map((key) => deviceProfiles[key].manufacturer),
      ),
    ];
    const choice = await this.ui.ask(
      tr(lang, "设备品牌", "DEVICE VENDOR"),
      `${automatic ? tr(lang, "0 自动分配 / ", "0 Auto-balance / ") : ""}${brands.map((brand, i) => `${i + 1} ${brand}`).join(" / ")}`,
      automatic ? "0" : "1",
    );
    if (automatic && choice === "0") return "auto";
    const brand = brands[Number(choice) - 1];
    if (!brand) throw new UserError(tr(lang, "品牌选择无效。", "Invalid vendor choice."));
    const profiles = devicePresetKeys.filter(
      (key) => deviceProfiles[key].manufacturer === brand,
    );
    const model = await this.ui.ask(
      tr(lang, "设备机型", "DEVICE MODEL"),
      profiles
        .map(
          (key, i) =>
            `${i + 1} ${devicePresetNames[key]} (${deviceProfiles[key].model})`,
        )
        .join(" / "),
      "1",
    );
    const key = profiles[Number(model) - 1];
    if (!key) throw new UserError(tr(lang, "机型选择无效。", "Invalid model choice."));
    return key;
  }

  private async askLibraryMeta(defaultLabel: string): Promise<{
    label: string;
    scope: "private" | "public";
    owner?: string;
  }> {
    const lang = this.lang;
    const label = await this.ui.ask(
      tr(lang, "导入运动记录", "IMPORT WORKOUT DATA"),
      tr(lang, "记录库名称", "Library label"),
      defaultLabel,
    );
    const rawScope = (
      await this.ui.ask(
        tr(lang, "可用范围", "LIBRARY SCOPE"),
        tr(
          lang,
          "1 私人（仅绑定单个账号） / 2 本机共享（多账号共用）",
          "1 private (single account) / 2 public (shared on machine)",
        ),
        this.ui.app.state.accounts.length ? "1" : "2",
      )
    )
      .trim()
      .toLowerCase();
    const scope: "private" | "public" =
      rawScope === "2" || rawScope === "public" || rawScope === "共享" || rawScope === "公用"
        ? "public"
        : rawScope === "1" || rawScope === "private" || rawScope === "私人" || rawScope === "私有"
          ? "private"
          : (() => {
              throw new UserError(
                tr(lang, "请输入 1（私人）或 2（共享）。", "Enter 1 (private) or 2 (public)."),
              );
            })();

    if (scope === "private" && !this.ui.app.state.accounts.length) {
      throw new UserError(
        tr(lang, "当前还没有账号，请先添加账号或选 2（共享）。", "No accounts yet; add an account first or choose 2 (public)."),
      );
    }
    let owner: string | undefined;
    if (scope === "private") {
      const accounts = this.ui.app.state.accounts;
      if (accounts.length === 1) {
        owner = accounts[0]!.id;
      } else {
        const pick = await this.ui.ask(
          tr(lang, "绑定账号", "OWNER ACCOUNT"),
          accounts.map((a, i) => `${i + 1}:${a.label}`).join(" / "),
          String(
            Math.max(
              0,
              accounts.findIndex((a) => a.id === this.ui.view.accountId),
            ) + 1,
          ),
        );
        owner = accounts[Number(pick) - 1]?.id;
        if (!owner) throw new UserError(tr(lang, "所属账号选择无效。", "Invalid owner selection."));
      }
    }
    return { label, scope, owner };
  }

  async import() {
    const lang = this.lang;
    const file = await this.ui.ask(
      tr(lang, "文件导入（自动解密）", "IMPORT FILE (AUTO-DECRYPT)"),
      tr(
        lang,
        "粘贴 ygty_mysport.db、手机备份 (.bak / .zip) 或 JSON 文件路径",
        "Path to ygty_mysport.db, Android backup (.bak / .zip), or JSON",
      ),
    );
    const { label, scope, owner } = await this.askLibraryMeta(
      tr(lang, "我的运动记录", "My Runs"),
    );
    const l = await this.ui.app.commands.importLibrary(file, label, scope, owner);
    this.ui.view.notice =
      lang === "en"
        ? `Decrypted & imported ${l.runCount} valid runs (Routes ${l.routeIds.join("/")}).`
        : `已解密导入 ${l.runCount} 条有效记录（路线 ${l.routeIds.join("/")}）。`;
  }

  async importFromPhone() {
    const lang = this.lang;
    await this.ui.confirm(
      tr(lang, "连接安卓手机读取（ADB）", "READ FROM ANDROID PHONE (ADB)"),
      tr(
        lang,
        "请用数据线连接手机并开启「USB 调试」（未 Root 的小米手机建议先在系统「手机备份」单独备份一次创高体育），现在开始读取？",
        "Connect Android phone via USB with USB Debugging enabled (on non-root Xiaomi, run a local backup of CGSport first). Read now?",
      ),
    );
    const { label, scope, owner } = await this.askLibraryMeta(
      tr(lang, "手机提取记录", "Phone Runs"),
    );
    const res = await this.ui.app.commands.importLibraryFromPhone(label, scope, owner);
    this.ui.view.notice =
      lang === "en"
        ? `Imported ${res.runCount} valid runs from phone (Routes ${res.routeIds.join("/")}).`
        : `已从${res.sourceHint}解密导入 ${res.runCount} 条有效记录（路线 ${res.routeIds.join("/")}）。`;
  }
}
