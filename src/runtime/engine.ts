import { animationRates, resolveAnimationFps, visualOpacities, resolveVisualOpacity } from '../render/appearance.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { handleScheduledSubmit } from '../protocol/scheduled-submit.js';
import type { WorkoutRecord } from '../protocol/records.js';
import {
  activeTask,
  BASE,
  cachedInformation,
  compatibilityKey,
  deviceHeaders,
  identity,
  migrateIdentity,
  newAccount,
  phoneVersion,
  safeText,
  UserError,
  type Account,
  type ColorTheme,
  type Device,
  type Language,
  type LogoFont,
  type Prepared,
  type RecordScope,
  type Task,
  type VisualStyle,
} from '../core/model.js';
import { loadSchoolProfile, type SchoolProfile } from '../campus/school-profile.js';
import { fetchSchoolDirectory, normalizeSchoolServerUrl, type SchoolDirectoryEntry } from '../campus/school-directory.js';
import { applyBinding, BindingConflict, commitBindings, recoverBindings, MemoryDeviceRegistry, type DeviceRegistry } from './device-registry.js';
import { Store } from './storage.js';
import { Transport, validateProxy } from './transport.js';
import { Protocol } from '../protocol/index.js';
import { canUse, importLibrary, importLibraryFromPhone, prepareOneShot, type PrepareOptions } from '../track/library.js';
import { parseJwtClaims, resolvePhoneDevice, type BackupHints, type BackupSessionHint } from '../campus/backup-snapshot.js';
import type { PhoneCandidateSummary } from '../app/contracts.js';
import { maskFixed } from '../core/privacy.js';
import { NativeSigner } from '../protocol/signer.js';
import { buildClient } from '../protocol/login.js';
import { buildV1 } from '../protocol/device.js';
import { assertGeometry } from '../track/geometry.js';
import { accountKey, allocateAndroidId, deviceConflicts, sameDevice, validDevice } from '../core/device-identity.js';
import { fetchInformation, fetchNoticeArticle, fetchRecordDetail, fetchSchoolNotices, type AccountInformation, type RecordDetail } from '../campus/information.js';
import { recordActivity, requestName } from '../core/activity.js';
import { isLogoFont, resolveFont, gradientSpeeds, resolveGradientSpeed } from '../render/logo-fonts.js';
import { deviceFromPreset, isDevicePreset, selectDeviceProfile, type DevicePreset } from '../core/device-profiles.js';
import { exportPortableBackup, importPortableBackup } from './portable-backup.js';

export const AUTO_AUDIT_DELAY_MS = 10 * 60_000;

interface AccountRecordCache {
  identity: string;
  sessionId: string;
  fetchedAt: number;
  records: WorkoutRecord[];
  archiveFetchedAt?: number;
  archiveRecords?: WorkoutRecord[];
  details: Map<string, RecordDetail>;
}

interface PhoneCandidate {
  username: string;
  serverUrl: string;
  schoolId?: string;
  device?: Device;
  session?: BackupSessionHint;
}

export class Engine extends EventEmitter {
  readonly background: boolean = false;
  readonly connected: boolean = true;
  private clients = new Map<string, { identity: string; transport: Transport; protocol: Protocol }>();
  private operations = new Set<string>();
  private armed = new Set<string>();
  private ticking = false;
  private restoring = false;
  private planning = false;
  private checkingSchool?: Promise<void>;
  private recordCache = new Map<string, AccountRecordCache>();
  private phoneCandidates = new Map<string, PhoneCandidate>();
  private informationAttempts = new Map<string, number>();
  private schoolAttempts = new Map<string, number>();
  private noticeAttempts = new Map<string, number>();
  private schoolProfile?: SchoolProfile;
  private schoolDirectoryCache?: { fetchedAt: number; list: SchoolDirectoryEntry[] };
  readonly startupNotices: string[] = [];
  constructor(readonly store: Store, private mock?: typeof fetch, private registry: DeviceRegistry = new MemoryDeviceRegistry()) { super(); }
  private get profile(): SchoolProfile {
    if (!this.schoolProfile) this.schoolProfile = loadSchoolProfile(this.store.root).profile;
    return this.schoolProfile;
  }
  account(id: string) { const a = this.store.state.accounts.find(v => v.id === id); if (!a) throw new UserError('账号不存在。'); return a; }
  client(a: Account) {
    if (this.account(a.id) !== a) throw new UserError('账号档案已被替换，请重新选择账号。');
    this.assertUniqueDevice(a);
    const old = this.clients.get(a.id), key = identity(a);
    if (old?.identity === key) return old.protocol;
    if (old) void old.transport.close();
    const service = new URL(a.school.baseUrl || BASE);
    const loginPath = new URL('api/f/v6/login', service).pathname;
    const transport = new Transport(a.proxy, this.mock, a.school.baseUrl), protocol = new Protocol(async (url, init) => {
      // 缓存的 client 也在每个请求边界复核身份；不能带旧 token 或新设备偷偷续用。
      if (this.account(a.id) !== a) throw new UserError('账号档案已被替换，请重新选择账号。');
      this.assertUniqueDevice(a);
      if (identity(a) !== key) throw new UserError('账号设备或网络配置已变化，请重新操作。');
      const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
      const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
      if (target.origin === service.origin) {
        if (!target.pathname.startsWith(service.pathname)) throw new UserError('请求超出账号服务路径。');
        const expected = deviceHeaders(a.device);
        if (headers.get('imei') !== expected.imei || headers.get('User-Agent') !== expected.userAgent)
          throw new UserError('请求设备标识与账号设置不匹配。');
        if (target.pathname !== loginPath && (!a.session || a.session.status === 'invalid' ||
          a.session.identity !== key || a.session.xh !== a.username || headers.get('cgAuthorization') !== a.session.token))
          throw new UserError('登录信息与当前账号不匹配，请重新登录。');
        if (target.pathname === loginPath && (!(init?.body instanceof URLSearchParams) ||
          init.body.get('username') !== a.username)) throw new UserError('登录账号与当前档案不匹配。');
        const binding = await this.registry.transaction(entries => entries.verify(a, true));
        if (this.account(a.id) !== a || identity(a) !== key) throw new UserError('账号档案已变更，请重新操作。');
        a.deviceUsage = binding.usage;
        if (target.pathname !== loginPath && (a.session?.status === 'invalid' || a.session?.token !== headers.get('cgAuthorization'))) throw new UserError('会话已变更。');
      } else if (headers.has('cgAuthorization') || headers.has('imei') || headers.has('client'))
        throw new UserError('更新检查的请求配置有误。');
      const request = requestName(target.pathname);
      try {
        const response = await transport.fetch(url, init);
        recordActivity(this.store.state, 'request', { accountId: a.id, request, status: response.status, level: response.ok ? 'info' : 'error' });
        return response;
      } catch (error) { recordActivity(this.store.state, 'request-error', { accountId: a.id, request, level: 'error' }); throw error; }
    });
    this.clients.set(a.id, { identity: key, transport, protocol }); return protocol;
  }
  hasTask(id: string) { return this.store.state.tasks.some(t => t.accountId === id && activeTask(t)); }
  async assertSession(id: string) {
    const a = this.account(id);
    this.client(a).session(a);
    await this.registry.transaction(table => table.verify(a));
  }
  async configureSettings(change: { maxConcurrent?: number; notifications?: boolean; termTarget?: number }) {
    if (change.maxConcurrent !== undefined && (!Number.isInteger(change.maxConcurrent) || change.maxConcurrent < 1 || change.maxConcurrent > 16) ||
      change.notifications !== undefined && typeof change.notifications !== 'boolean' ||
      change.termTarget !== undefined && (!Number.isInteger(change.termTarget) || change.termTarget < 0 || change.termTarget > 300))
      throw new UserError('设置无效。');
    if (change.maxConcurrent !== undefined) this.store.state.settings.maxConcurrent = change.maxConcurrent;
    if (change.notifications !== undefined) this.store.state.settings.notifications = change.notifications;
    if (change.termTarget !== undefined) {
      if (change.termTarget === 0) delete this.store.state.settings.termTarget;
      else this.store.state.settings.termTarget = change.termTarget;
    }
    await this.store.save(); this.emit('change');
  }
  private alignIdleAccountRoutes() {
    for (const a of this.store.state.accounts) {
      if (this.hasTask(a.id)) continue;
      const libRouteIds = new Set(this.store.state.libraries.filter(l => canUse(l, a)).flatMap(l => l.routeIds));
      const rules = a.information?.rules.data ?? [];
      const safeRules = rules.filter(r => !r.faceAuth && !r.dynamicWaypoints).map(r => r.id);
      const ruleIds = rules.map(r => r.id);
      if (libRouteIds.size > 0 && !libRouteIds.has(a.routeId)) {
        a.routeId =
          [...libRouteIds].find(id => safeRules.includes(id)) ??
          [...libRouteIds].find(id => !ruleIds.length || ruleIds.includes(id)) ??
          [...libRouteIds][0]!;
      } else if (ruleIds.length > 0 && !ruleIds.includes(a.routeId)) {
        a.routeId =
          safeRules.find(id => libRouteIds.has(id)) ??
          ruleIds.find(id => libRouteIds.has(id)) ??
          safeRules[0] ??
          ruleIds[0]!;
      }
    }
  }
  async listSchools(): Promise<SchoolDirectoryEntry[]> {
    const now = Date.now();
    if (this.schoolDirectoryCache && now - this.schoolDirectoryCache.fetchedAt < 10 * 60_000) {
      return structuredClone(this.schoolDirectoryCache.list);
    }
    const transport = new Transport(this.store.state.settings.schoolProxy ?? '', this.mock);
    try {
      const list = await fetchSchoolDirectory(transport.fetch);
      this.schoolDirectoryCache = { fetchedAt: now, list };
      return structuredClone(list);
    } finally {
      await transport.close();
    }
  }
  private recordPhoneHints(libraryId: string, hints?: BackupHints) {
    this.phoneCandidates.delete(libraryId);
    if (!hints?.username || !hints.serverUrl) return;
    const device = resolvePhoneDevice(hints);
    if (!device) return;
    if (this.phoneCandidates.size >= 16) {
      const oldest = this.phoneCandidates.keys().next().value;
      if (oldest) this.phoneCandidates.delete(oldest);
    }
    this.phoneCandidates.set(libraryId, {
      username: hints.username,
      serverUrl: hints.serverUrl,
      ...(hints.schoolId ? { schoolId: hints.schoolId } : {}),
      device,
      ...(hints.session ? { session: hints.session } : {}),
    });
  }
  async importLibrary(file: string, label: string, scope: Account['sourceMode'], owner?: string) {
    this.assertWritable();
    let captured: BackupHints | undefined;
    const result = await importLibrary(this.store, file, label, scope, owner, h => { captured = h; });
    this.recordPhoneHints(result.id, captured);
    this.emit('change');
    return result;
  }
  async importLibraryFromPhone(label: string, scope: Account['sourceMode'], owner?: string) {
    this.assertWritable();
    let captured: BackupHints | undefined;
    const result = await importLibraryFromPhone(this.store, label, scope, owner, h => { captured = h; });
    this.recordPhoneHints(result.id, captured);
    this.emit('change');
    return result;
  }
  async deleteLibrary(id: string) {
    const lib = this.store.state.libraries.find(l => l.id === id);
    if (!lib) throw new UserError('记录库不存在。');
    if (this.store.state.tasks.some(t => activeTask(t) && t.prepared.libraryId === id)) {
      throw new UserError('有未结束任务正在使用该记录库，请先处理任务后再删除。');
    }
    this.phoneCandidates.delete(id);
    this.store.state.libraries = this.store.state.libraries.filter(l => l.id !== id);
    for (const a of this.store.state.accounts) {
      if (a.libraryId === id) delete a.libraryId;
    }
    await this.store.save();
    await this.store.deleteLibrary(id);
    this.emit('change');
  }
  async exportBackup(filePath: string, passphrase: string, includeSessions = true) {
    if (this.operations.size || this.planning || this.ticking) throw new UserError('正在处理其他操作，请稍候再导出。');
    return exportPortableBackup(this.store, filePath, passphrase, includeSessions);
  }
  async importBackup(filePath: string, passphrase: string) {
    if (this.operations.size || this.planning || this.ticking) throw new UserError('正在处理其他操作，请稍候再导入。');
    this.assertWritable();
    this.restoring = true;
    try {
      const res = await importPortableBackup(this.store, filePath, passphrase, this.registry);
      const clients = [...this.clients.values()];
      this.clients.clear(); this.informationAttempts.clear(); this.schoolAttempts.clear(); this.noticeAttempts.clear();
      await Promise.all(clients.map(c => c.transport.close()));
      this.hydrateRecordCache();
      recordActivity(this.store.state, 'profile');
      await this.store.save();
      this.emit('change');
      return res;
    } finally { this.restoring = false; }
  }
  async loadCachedRecords(id: string, sportId?: string | null, scope?: RecordScope | null) {
    const resolvedScope = scope ?? 'current';
    if (resolvedScope !== 'current' && resolvedScope !== 'archive') throw new UserError('记录范围无效。');
    const cache = this.cachedRecords(id, resolvedScope); if (!cache) return undefined;
    const detail = sportId && cache.records.some(r => r.sportId === sportId) ? this.recordCache.get(id)?.details.get(sportId) : undefined;
    return { ...cache, ...(detail ? { detail: structuredClone(detail) } : {}) };
  }
  async reconcileTask(id: string, refresh = true) {
    const task = this.store.state.tasks.find(t => t.id === id), sportId = task?.session?.sportId || task?.result?.sportId;
    if (!task || !sportId) throw new UserError('任务尚未取得 sportId。');
    this.assertReadingAllowed(task.accountId);
    let cached = this.cachedRecords(task.accountId, 'current');
    if (refresh) { await this.fetchRecordsForAccount(task.accountId, true, 'current'); cached = this.cachedRecords(task.accountId, 'current'); }
    if (!cached) throw new UserError('暂无记录缓存，按 C 刷新核对。');
    const record = cached.records.find(r => r.sportId === sportId || (task.result?.sportId && r.sportId === task.result.sportId));
    task.audit = {
      checkedAt: cached.fetchedAt, found: !!record,
      record: record ? structuredClone(record) : task.audit?.record,
      recordAt: record ? cached.fetchedAt : task.audit?.recordAt,
    };
    if (record && record.checkStatus !== '0') task.autoAuditAt = undefined;
    await this.store.save(); this.emit('change'); return task.audit;
  }
  private assertUniqueDevice(a: Account) {
    if (this.store.state.pendingBindings) throw new UserError('设备绑定待恢复，请重新打开档案。');
    if (!validDevice(a.device)) throw new UserError('设备字段格式错误。');
    const conflicts = deviceConflicts(a, this.store.state.accounts);
    if (conflicts.length) throw new UserError(`设备标识冲突：${a.label} 与 ${conflicts.map(v => v.label).join('、')} 重复。请在设置中更换设备标识后重新登录。`);
  }
  private hydrateRecordCache() {
    this.recordCache.clear();
    for (const a of this.store.state.accounts) {
      const rc = a.recordCache;
      if (rc && a.session && rc.identity === identity(a) && rc.sessionId === a.session.id && Array.isArray(rc.records)) {
        const details = new Map<string, RecordDetail>();
        if (rc.details && typeof rc.details === 'object') {
          for (const [k, v] of Object.entries(rc.details)) if (v && typeof v === 'object') details.set(k, structuredClone(v));
        }
        this.recordCache.set(a.id, {
          identity: rc.identity,
          sessionId: rc.sessionId,
          fetchedAt: rc.fetchedAt,
          records: structuredClone(rc.records),
          ...(Array.isArray(rc.archiveRecords) ? { archiveFetchedAt: rc.archiveFetchedAt, archiveRecords: structuredClone(rc.archiveRecords) } : {}),
          details,
        });
      }
    }
  }
  async initialize() {
    this.startupNotices.length = 0;
    await recoverBindings(this.store, this.registry);
    const loadedProfile = loadSchoolProfile(this.store.root);
    this.schoolProfile = loadedProfile.profile;
    if (loadedProfile.fromDisk) {
      this.store.state.settings.schoolName = loadedProfile.profile.name;
      this.store.state.settings.schoolNameEn = loadedProfile.profile.nameEn;
    }
    if (!['astolfo', 'spectrum', 'mescaline', 'acid'].includes(this.store.state.settings.colorTheme ?? '')) this.store.state.settings.colorTheme = 'mescaline';
    this.store.state.settings.logoFont = resolveFont(this.store.state.settings.logoFont);
    if (!['track', 'spiral', 'none'].includes(this.store.state.settings.visualStyle ?? '')) this.store.state.settings.visualStyle = 'track';

    if (typeof this.store.state.settings.motion !== 'boolean') this.store.state.settings.motion = true;
    if (typeof this.store.state.settings.privacyMode !== 'boolean') this.store.state.settings.privacyMode = false;
    if (this.store.state.settings.language !== undefined && !['zh', 'en'].includes(this.store.state.settings.language)) {
      this.store.state.settings.language = 'zh';
    }
    this.store.state.settings.gradientSpeed = resolveGradientSpeed(this.store.state.settings.gradientSpeed);
    this.store.state.settings.animationFps = resolveAnimationFps(this.store.state.settings.animationFps);
    this.store.state.settings.visualOpacity = resolveVisualOpacity(this.store.state.settings.visualOpacity);
    this.store.state.settings.schoolId ??= this.store.state.accounts.find(a => a.school.id)?.school.id ?? loadedProfile.profile.schoolId ?? '';
    for (const a of this.store.state.accounts) {
      migrateIdentity(a, this.store.state.tasks);
      if (a.session?.status === 'verified') a.session.status = 'saved';
      if (a.information && a.information.rulesSchemaVersion !== 2 && a.information.rules?.data?.some(r => r.faceAuth || r.dynamicWaypoints)) {
        a.information.rules = { error: '尚未读取。' };
        delete a.information.schoolFetchedAt;
        a.information.rulesSchemaVersion = 2;
      }
    }
    this.hydrateRecordCache();
    for (const t of this.store.state.tasks) {
      if (t.phase === 'waiting' || t.phase === 'queued') { t.resumePhase = t.phase; t.phase = 'paused'; t.note = '任务已暂停，按 R 恢复。'; }
      else if (t.phase === 'starting' || t.phase === 'committing') { t.phase = 'review'; t.note = '上次提交中断，按 C 查看结果。'; }
    }
    if (this.store.state.accounts.length) {
      const results = await this.registry.transaction(entries => {
        for (const a of this.store.state.accounts) entries.observe(a);
        return this.store.state.accounts.map(a => {
          try { return entries.verify(a); }
          catch (e) { if (e instanceof BindingConflict) return undefined; throw e; }
        });
      });
      this.store.state.accounts.forEach((a, index) => {
        const binding = results[index];
        if (binding) applyBinding(a, binding);
        else { a.bindingConflict = true; this.startupNotices.push(a.label + ' 设备标识冲突，请核对档案；原值已保留。'); }
      });
    }
    recordActivity(this.store.state, 'startup', { count: this.store.state.accounts.length });
    const sessions = this.store.state.accounts.filter(a => a.session && a.session.status !== 'invalid' && a.session.identity === identity(a) && a.session.xh === a.username).length;
    if (sessions) recordActivity(this.store.state, 'sessions', { count: sessions });
    if (this.store.root) await this.store.save();
  }
  async setColorTheme(theme: ColorTheme) {
    return this.configureAppearance({ colorTheme: theme });
  }
  async configureAppearance(change: { colorTheme?: ColorTheme; logoFont?: LogoFont; visualStyle?: VisualStyle; visualOpacity?: number; gradientSpeed?: number; animationFps?: number; motion?: boolean; privacyMode?: boolean; language?: Language }) {
    if (change.colorTheme !== undefined && !['astolfo', 'spectrum', 'mescaline', 'acid'].includes(change.colorTheme) ||
      change.logoFont !== undefined && !isLogoFont(change.logoFont) ||
      change.visualStyle !== undefined && !['track', 'spiral', 'none'].includes(change.visualStyle) ||
      change.motion !== undefined && typeof change.motion !== 'boolean' ||
      change.privacyMode !== undefined && typeof change.privacyMode !== 'boolean' ||
      change.language !== undefined && !['zh', 'en'].includes(change.language) ||
      change.gradientSpeed !== undefined && !(gradientSpeeds as readonly number[]).includes(change.gradientSpeed) ||
      change.animationFps !== undefined && !(animationRates as readonly number[]).includes(change.animationFps) ||
      change.visualOpacity !== undefined && !(visualOpacities as readonly number[]).includes(change.visualOpacity)) throw new UserError('外观选项无效。');
    const s = this.store.state.settings;
    if (change.colorTheme !== undefined) s.colorTheme = change.colorTheme; if (change.logoFont !== undefined) s.logoFont = change.logoFont;
    if (change.visualStyle !== undefined) s.visualStyle = change.visualStyle; if (change.motion !== undefined) s.motion = change.motion;
    if (change.privacyMode !== undefined) s.privacyMode = change.privacyMode;
    if (change.language !== undefined) s.language = change.language;
    if (change.gradientSpeed !== undefined) s.gradientSpeed = change.gradientSpeed;
    if (change.animationFps !== undefined) s.animationFps = change.animationFps;
    if (change.visualOpacity !== undefined) s.visualOpacity = change.visualOpacity;
    recordActivity(this.store.state, change.colorTheme !== undefined ? 'theme' : 'appearance', { theme: change.colorTheme }); await this.store.save(); this.emit('change');
  }
  async addAccount(label: string, username: string, schoolInput: string | SchoolDirectoryEntry, preset: DevicePreset | 'auto' = 'auto') {
    this.assertWritable();
    if (!label.trim() || !/^[a-zA-Z0-9_@.-]{2,80}$/.test(username)) throw new UserError('昵称不能为空，账号格式不正确。');
    const profile = this.profile;
    let resolvedSchool: Account['school'];
    if (typeof schoolInput === 'object' && schoolInput !== null) {
      const baseUrl = normalizeSchoolServerUrl(schoolInput.baseUrl, schoolInput.code);
      if (!baseUrl || !/^[a-zA-Z0-9_-]{1,32}$/.test(String(schoolInput.id ?? '').trim())) {
        throw new UserError('学校服务配置无效。');
      }
      resolvedSchool = {
        id: String(schoolInput.id).trim(),
        provinceCode: String(schoolInput.provinceCode ?? '').trim().slice(0, 16),
        randomCode: String(schoolInput.randomCode ?? '').trim().slice(0, 16),
        baseUrl,
        name: String(schoolInput.name ?? '').trim().slice(0, 60) || undefined,
        nameEn: String(schoolInput.nameEn ?? '').trim().slice(0, 80) || undefined,
        code: String(schoolInput.code ?? '').trim().slice(0, 32) || undefined,
        ...(schoolInput.loginType ? { loginType: schoolInput.loginType } : {}),
        ...(schoolInput.loginUrl ? { loginUrl: schoolInput.loginUrl } : {}),
      };
    } else {
      const existingSchool = this.store.state.settings.defaultSchool ?? this.store.state.accounts.find(a => a.school.id === (schoolInput || this.store.state.settings.schoolId))?.school ?? this.store.state.accounts[0]?.school;
      const resolvedSchoolId = (schoolInput || existingSchool?.id || profile.schoolId || '').trim();
      resolvedSchool = existingSchool && (!schoolInput || schoolInput.trim() === existingSchool.id)
        ? { ...existingSchool, id: resolvedSchoolId }
        : { id: resolvedSchoolId, provinceCode: profile.provinceCode, randomCode: profile.randomCode, baseUrl: profile.baseUrl };
    }
    if (this.store.state.accounts.some(a => accountKey(a) === accountKey({ username, school: resolvedSchool }))) {
      throw new UserError('该服务的账号已存在，请进入已有档案。');
    }
    if (preset !== 'auto' && !isDevicePreset(preset)) throw new UserError('设备预设无效。');
    const a = await this.registry.transaction(entries => {
      const existing = entries.get({ username, school: resolvedSchool });
      let device = existing?.device;
      if (!device) {
        const occupied = [...this.store.state.accounts, ...entries.entries.flatMap(e => [e.device, ...e.alternatives].map(device => ({ device })))];
        device = deviceFromPreset(preset === 'auto' ? selectDeviceProfile(this.store.state.accounts) : preset, allocateAndroidId(occupied));
      }
      const account = newAccount(label.trim().slice(0, 40), username, resolvedSchool.id, profile, device);
      account.school = resolvedSchool;
      account.deviceUsage = existing?.usage ?? 'unused';
      account.deviceSource = existing?.source ?? 'tui';
      applyBinding(account, entries.create(account));
      return account;
    });
    this.assertWritable();
    if (this.store.state.accounts.some(other => accountKey(other) === accountKey(a))) throw new UserError('该服务的账号已存在。');
    this.assertUniqueDevice(a);
    if (!this.store.state.accounts.length || !this.store.state.settings.schoolId) {
      this.store.state.settings.schoolId = resolvedSchool.id;
      if (resolvedSchool.name) this.store.state.settings.schoolName = resolvedSchool.name;
      if (resolvedSchool.nameEn) this.store.state.settings.schoolNameEn = resolvedSchool.nameEn;
    }
    this.store.state.accounts.push(a);
    this.alignIdleAccountRoutes();
    recordActivity(this.store.state, 'account-added', { accountId: a.id });
    await this.store.save();
    return a;
  }
  private assertWritable() {
    if (this.restoring || this.store.state.pendingBindings) throw new UserError('设备绑定或备份恢复进行中，请稍后重试。');
  }
  async inspectDevice(id: string) {
    const a = this.account(id);
    return this.registry.transaction(entries => {
      const entry = entries.get(a);
      let conflict = false;
      if (entry) {
        try { entries.verify(a); } catch (e) { if (!(e instanceof BindingConflict)) throw e; conflict = true; }
      }
      return { device: structuredClone(a.device), registered: entry?.tenantId === a.school.id ? structuredClone(entry.device) : undefined, revision: entry?.version, conflict };
    });
  }
  async acceptRegisteredDevice(id: string, revision: number) {
    return this.exclusive(id, async () => {
      const a = this.account(id);
      if (this.hasTask(id)) throw new UserError('账号有未处理任务。');
      await commitBindings(this.store, this.registry, table => table.acceptRegistered(a, revision), entry => {
        this.assertUniqueDevice({ ...a, device: entry.device });
        applyBinding(a, entry);
        this.invalidateProfile(a);
      });
    });
  }
  async inspectPhoneCandidate(libraryId: string): Promise<PhoneCandidateSummary | undefined> {
    const lib = this.store.state.libraries.find(l => l.id === libraryId);
    const c = this.phoneCandidates.get(libraryId);
    if (!lib || !c?.device) return undefined;
    let matched: Account | undefined;
    if (lib.scope === 'private') {
      const owner = this.store.state.accounts.find(a => a.id === lib.ownerAccountId);
      if (!owner || owner.username !== c.username || owner.school.baseUrl !== c.serverUrl ||
        (c.schoolId && owner.school.id && c.schoolId !== owner.school.id)) return undefined;
      matched = owner;
    } else {
      matched = this.store.state.accounts.find(a =>
        a.username === c.username && a.school.baseUrl === c.serverUrl &&
        (!c.schoolId || !a.school.id || c.schoolId === a.school.id),
      );
    }
    if (deviceConflicts({ id: matched?.id ?? '', device: c.device }, this.store.state.accounts).length > 0) return undefined;
    const priv = Boolean(this.store.state.settings.privacyMode);
    const displayAndroidId = priv ? maskFixed(c.device.androidId, 16) : c.device.androidId;
    const displayUser = priv ? maskFixed(c.username, Math.min(12, c.username.length)) : c.username;
    const hasSession = Boolean(c.session && Number(c.session.loginOutTime) > Date.now());
    return {
      libraryId,
      username: displayUser,
      serverUrl: c.serverUrl,
      ...(c.schoolId ? { schoolId: c.schoolId } : {}),
      model: `${c.device.manufacturer} ${c.device.model}`,
      displayAndroidId,
      hasDevice: true,
      hasSession,
      ...(matched ? {
        matchedAccountId: matched.id,
        sameDevice: sameDevice(matched.device, c.device),
        accountUsed: matched.deviceUsage !== 'unused',
      } : {}),
    };
  }
  async adoptPhoneCandidate(accountId: string, libraryId: string, restoreSession = true): Promise<{ deviceChanged: boolean; sessionRestored: boolean }> {
    return this.exclusive(accountId, async () => {
      const a = this.account(accountId);
      if (this.hasTask(accountId)) throw new UserError('账号有未处理任务，请先处理后再同步真机档案。');
      const lib = this.store.state.libraries.find(l => l.id === libraryId);
      const c = this.phoneCandidates.get(libraryId);
      if (!lib || !c?.device) throw new UserError('未找到可用的手机备份设备信息。');
      if (lib.scope === 'private' && lib.ownerAccountId !== accountId) throw new UserError('私有记录库归属与目标账号不一致。');
      if (a.username !== c.username || a.school.baseUrl !== c.serverUrl || (c.schoolId && a.school.id && c.schoolId !== a.school.id)) {
        throw new UserError('手机备份归属（学校或学号）与当前账号不一致。');
      }
      this.assertUniqueDevice({ ...a, device: c.device });
      const deviceChanged = !sameDevice(a.device, c.device);
      await commitBindings(this.store, this.registry, entries => {
        const entry = entries.replace(a, c.device!, 'phone');
        entry.source = 'phone';
        return entry;
      }, binding => {
        applyBinding(a, binding);
        if (deviceChanged) this.invalidateProfile(a);
      });
      let sessionRestored = false;
      if (restoreSession && c.session && Number(c.session.loginOutTime) > Date.now()) {
        const claims = parseJwtClaims(c.session.token);
        if (claims?.sub === a.username && (!claims.exp || claims.exp * 1000 > Date.now()) &&
          (!claims.schoolId || !a.school.id || claims.schoolId === a.school.id)) {
          a.session = {
            id: randomUUID(),
            token: c.session.token,
            secret: c.session.secret,
            loginOutTime: c.session.loginOutTime,
            xh: a.username,
            name: safeText(c.session.name ?? '', 40),
            gender: c.session.gender === '2' ? '2' : '1',
            identity: identity(a),
            createdAt: Date.now(),
            status: 'saved',
          };
          applyBinding(a, await this.registry.transaction(entries => entries.verify(a, true)));
          a.information = undefined; a.recordCache = undefined;
          this.recordCache.delete(accountId); this.informationAttempts.delete(accountId);
          this.schoolAttempts.delete(accountId); this.noticeAttempts.delete(accountId);
          try {
            const protocol = this.client(a);
            await this.preflight(a);
            a.information = await fetchInformation(a, protocol.fetch, 'school');
            this.schoolAttempts.set(accountId, Date.now());
            this.alignIdleAccountRoutes();
          } catch { /* best-effort prefetch */ }
          recordActivity(this.store.state, 'session-saved', { accountId, level: 'ok' });
          sessionRestored = true;
        }
      }
      this.phoneCandidates.delete(libraryId);
      recordActivity(this.store.state, 'profile', { accountId });
      return { deviceChanged, sessionRestored };
    });
  }
  async stagePhoneCandidate(libraryId: string): Promise<void> {
    this.assertWritable();
    const lib = this.store.state.libraries.find(l => l.id === libraryId);
    const c = this.phoneCandidates.get(libraryId);
    if (!lib || !c?.device) throw new UserError('未找到可登记的手机设备信息。');
    const key = accountKey({ username: c.username, school: { id: c.schoolId ?? '', provinceCode: '', randomCode: '', baseUrl: c.serverUrl } });
    if (this.store.state.accounts.some(a => accountKey(a) === key)) {
      throw new UserError('该账号已存在，请直接同步到对应账号。');
    }
    if (deviceConflicts({ id: '', device: c.device }, this.store.state.accounts).length > 0) {
      throw new UserError('该手机设备标识与现有账号冲突，无法登记。');
    }
    await this.registry.transaction(entries => entries.stagePhone(key, c.schoolId ?? '', c.device!));
    this.phoneCandidates.delete(libraryId);
  }
  async configure(id: string, change: Partial<Pick<Account, 'label' | 'libraryId' | 'device' | 'proxy' | 'routeId' | 'sourceMode' | 'school'>>) {
    const allowed = new Set(['label', 'libraryId', 'device', 'proxy', 'routeId', 'sourceMode', 'school']);
    if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(key => !allowed.has(key)))
      throw new UserError('账号设置含不允许修改的字段。');
    const a = this.account(id);
    if (this.hasTask(id) || this.operations.has(id)) throw new UserError('账号有未处理任务或请求，不能更改档案。');
    const oldIdentity = identity(a);
    if (change.proxy !== undefined) change.proxy = validateProxy(change.proxy);
    if (change.school) {
      const normalized = normalizeSchoolServerUrl(change.school.baseUrl, change.school.code);
      if (!normalized) throw new UserError('学校服务地址无效。');
      change.school = { ...change.school, baseUrl: normalized };
    }
    const target = { ...a, ...change };
    if (this.store.state.accounts.some(other => other.id !== id && accountKey(other) === accountKey(target)))
      throw new UserError('目标学校已存在相同账号。');
    return this.exclusive(id, async () => {
      const crossTenant = accountKey(target) !== accountKey(a);
      const retag = !crossTenant && target.school.id !== a.school.id;
      if (change.device || crossTenant || retag) {
        if (!crossTenant) this.assertUniqueDevice(target);
        await commitBindings(this.store, this.registry, entries => {
          if (retag) return entries.retagTenant(a, target);
          if (!crossTenant) return entries.replace(a, target.device, 'manual');
          entries.verify(a);
          if (!entries.get(target)) throw new UserError('目标学校尚无设备绑定，请先为该校明确添加账号。');
          return entries.create(target);
        }, binding => {
          applyBinding(target, binding);
          this.assertUniqueDevice(target);
          if (crossTenant || retag) {
            for (const library of this.store.state.libraries) {
              if (library.scope === 'private' && library.ownerAccountId === id) {
                library.schoolBaseUrl ??= a.school.baseUrl;
                library.schoolId ??= a.school.id;
              }
            }
            delete a.libraryId; delete target.libraryId;
          }
          Object.assign(a, target);
          if (identity(a) !== oldIdentity) this.invalidateProfile(a);
        });
      } else {
        Object.assign(a, target);
        if (identity(a) !== oldIdentity) this.invalidateProfile(a);
      }
      recordActivity(this.store.state, 'profile', { accountId: id });
    });
  }
  private invalidateProfile(a: Account) {
    if (a.session) a.session.status = 'invalid';
    delete a.compatibility; delete a.information; delete a.recordCache;
    this.recordCache.delete(a.id); this.informationAttempts.delete(a.id);
    this.schoolAttempts.delete(a.id); this.noticeAttempts.delete(a.id);
    const client = this.clients.get(a.id);
    this.clients.delete(a.id);
    void client?.transport.close().catch(() => {});
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.assertWritable();
    if (this.operations.has(id)) throw new UserError('此账号正在处理其他操作。');
    this.operations.add(id);
    try { return await work(); }
    catch (error) { recordActivity(this.store.state, 'operation-stopped', { accountId: id, level: 'warn' }); throw error; }
    finally { this.operations.delete(id); await this.store.save(); this.emit('change'); }
  }
  async check(id: string) { return this.exclusive(id, async () => {
    const a = this.account(id); a.compatibility = await this.client(a).check(a);
    if (a.school.id === this.store.state.settings.schoolId) this.store.state.settings.compatibility = a.compatibility;
    recordActivity(this.store.state, 'compatibility', { accountId: id, compatibility: a.compatibility.status, level: a.compatibility.status === 'ok' ? 'ok' : 'warn' });
    return a.compatibility;
  }); }
  async configureSchool(schoolInput: string | SchoolDirectoryEntry, proxy = '') {
    if (this.operations.size || this.store.state.tasks.some(t => activeTask(t))) throw new UserError('先处理未结束任务，再修改学校配置。');
    this.assertWritable();
    const directory = typeof schoolInput === 'string' ? undefined : schoolInput;
    const id = (typeof schoolInput === 'string' ? schoolInput : schoolInput.id).trim();
    const baseUrl = directory && normalizeSchoolServerUrl(directory.baseUrl, directory.code);
    if ((directory && !baseUrl) || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new UserError('学校服务配置无效。');
    const settings = this.store.state.settings;
    const schoolProxy = validateProxy(proxy);
    const keys = this.store.state.accounts.map(accountKey);
    if (new Set(keys).size !== keys.length) throw new UserError('学校配置含重复账号，请先核对。');
    if (directory && baseUrl) {
      for (const a of this.store.state.accounts) {
        const school = { ...a.school, ...directory, id, baseUrl };
        if (a.school.id !== id || accountKey(a) !== accountKey({ ...a, school })) continue;
        const oldIdentity = identity(a);
        a.school = school;
        if (identity(a) !== oldIdentity) this.invalidateProfile(a);
      }
    }
    settings.schoolProxy = schoolProxy;
    if (directory || id !== settings.schoolId) {
      settings.schoolName = directory?.name;
      settings.schoolNameEn = directory?.nameEn;
    }
    settings.defaultSchool = directory && baseUrl ? { ...directory, id, baseUrl } :
      this.store.state.accounts.find(a => a.school.id === id)?.school;
    settings.schoolId = id;
    this.store.state.settings.compatibility = undefined; await this.store.save();
  }
  async checkSchool() {
    if (this.checkingSchool) return this.checkingSchool;
    this.checkingSchool = (async () => {
      const profile = this.profile;
      const refSchool = this.store.state.settings.defaultSchool ?? this.store.state.accounts.find(a => a.school.id === this.store.state.settings.schoolId)?.school;
      const sample = newAccount('school-check', 'metadata-only', this.store.state.settings.schoolId ?? refSchool?.id ?? profile.schoolId ?? '', profile);
      if (refSchool) sample.school = { ...refSchool, id: sample.school.id };
      const transport = new Transport(this.store.state.settings.schoolProxy ?? '', this.mock, sample.school.baseUrl);
      try { this.store.state.settings.compatibility = await new Protocol(transport.fetch).check(sample);
        const status = this.store.state.settings.compatibility.status; recordActivity(this.store.state, 'compatibility', { compatibility: status, level: status === 'ok' ? 'ok' : 'warn' }); await this.store.save(); }
      finally { await transport.close(); }
    })();
    try { await this.checkingSchool; } finally { this.checkingSchool = undefined; this.emit('change'); }
  }
  private async preflight(a: Account) {
    const c = this.store.state.settings.compatibility;
    if (c?.key === compatibilityKey(a)) a.compatibility = c;
    await this.client(a).ensure(a);
    if (a.school.id === this.store.state.settings.schoolId) this.store.state.settings.compatibility = a.compatibility;
  }
  async ensureCompatible(id: string) { await this.preflight(this.account(id)); await this.store.save(); }
  async login(id: string, password: string) { return this.exclusive(id, async () => {
    const a = this.account(id);
    if (this.hasTask(id)) throw new UserError('有未处理任务，不能创建替换会话。');
    if (!password) throw new UserError('密码不能为空。');
    const trimmed = password.trim();
    const tokenParts = trimmed.split('.');
    if (tokenParts.length === 5 && tokenParts[3]!.length >= 16 && /^\d{10,16}$/.test(tokenParts[4]!)) {
      const jwt = `${tokenParts[0]}.${tokenParts[1]}.${tokenParts[2]}`;
      const secret = tokenParts[3]!;
      const loginOutTime = tokenParts[4]!;
      const claims = parseJwtClaims(jwt);
      if (!claims?.sub) {
        applyBinding(a, await this.registry.transaction(entries => entries.verify(a, true)));
        throw new UserError('无法验证粘贴令牌的学校与账号归属，请使用学校认证流程。');
      }
      if (claims.sub !== a.username) throw new UserError('粘贴令牌的学号与当前账号不一致。');
      if (claims.schoolId && a.school.id && claims.schoolId !== a.school.id) {
        throw new UserError('粘贴令牌的学校与当前账号不一致。');
      }
      if ((claims.exp !== undefined && claims.exp * 1000 <= Date.now()) || Number(loginOutTime) <= Date.now()) {
        throw new UserError('粘贴令牌已过期，请重新获取。');
      }
      await this.preflight(a);
      applyBinding(a, await this.registry.transaction(entries => entries.verify(a, true)));
      await this.store.save();
      const verifyTransport = new Transport(a.proxy, this.mock, a.school.baseUrl);
      let xm = '';
      let gender = '1';
      try {
        const verifyPath = `api/l/v6/u/info?xh=${encodeURIComponent(a.username)}`;
        const sig = await new NativeSigner({ secret }).sign({ method: 'GET', signPath: `/${verifyPath}` });
        const d = deviceHeaders(a.device);
        const resp = await verifyTransport.fetch(a.school.baseUrl + verifyPath, {
          method: 'GET',
          headers: {
            imei: d.imei,
            'User-Agent': d.userAgent,
            v1: buildV1(),
            client: buildClient(secret),
            cgAuthorization: jwt,
            timestamp: sig.timestamp,
            sign: sig.sign,
          },
        });
        const api = resp.ok ? await resp.json() as { code?: unknown; data?: Record<string, unknown> } : undefined;
        if (!api || api.code !== 200 || !api.data || typeof api.data !== 'object' || String(api.data.xh ?? '') !== a.username) {
          throw new UserError('无法验证粘贴令牌的学校与账号归属，请确认令牌未失效。');
        }
        xm = safeText(api.data.xm ?? '', 40);
        gender = String(api.data.xb ?? '1') === '2' ? '2' : '1';
      } finally {
        await verifyTransport.close();
      }
      a.session = {
        id: randomUUID(),
        token: jwt,
        secret,
        loginOutTime,
        xh: a.username,
        name: xm,
        gender,
        identity: identity(a),
        createdAt: Date.now(),
        status: 'verified',
      };
      a.information = undefined; a.recordCache = undefined; this.recordCache.delete(id); this.informationAttempts.delete(id); this.schoolAttempts.delete(id); this.noticeAttempts.delete(id);
      try {
        const protocol = this.client(a);
        a.information = await fetchInformation(a, protocol.fetch, 'school');
        this.schoolAttempts.set(id, Date.now());
        this.alignIdleAccountRoutes();
      } catch { /* best-effort rules prefetch */ }
      recordActivity(this.store.state, 'session-saved', { accountId: id, level: 'ok' });
      return;
    }
    if (Date.now() - (a.lastLoginAt ?? 0) < 60_000) throw new UserError('请间隔 60 秒再登录。');
    await this.preflight(a);
    applyBinding(a, await this.registry.transaction(entries => entries.verify(a, true)));
    a.lastLoginAt = Date.now(); await this.store.save();
    const protocol = this.client(a);
    try {
      a.session = await protocol.login(a, password);
    } catch (err) {
      if (a.school.loginType === '3') {
        const msg = err instanceof UserError ? err.message : '登录失败';
        throw new UserError(`${msg}（该校启用了统一身份认证：可粘贴 5 段 CAS Token，或在记录库按 P/I 从手机备份恢复）`);
      }
      throw err;
    }
    a.information = undefined; a.recordCache = undefined; this.recordCache.delete(id); this.informationAttempts.delete(id); this.schoolAttempts.delete(id); this.noticeAttempts.delete(id);
    // 登录后顺带拉取学校场地规则与电子围栏（失败不阻断登录会话）
    try {
      a.information = await fetchInformation(a, protocol.fetch, 'school');
      this.schoolAttempts.set(id, Date.now());
      this.alignIdleAccountRoutes();
    } catch { /* best-effort rules prefetch */ }
    recordActivity(this.store.state, 'session-saved', { accountId: id, level: 'ok' });
  }); }
  async records(id: string, scope?: RecordScope | null): Promise<WorkoutRecord[]> {
    const resolvedScope = scope ?? 'current';
    if (resolvedScope !== 'current' && resolvedScope !== 'archive') throw new UserError('记录范围无效。');
    return this.fetchRecordsForAccount(id, false, resolvedScope);
  }
  private async fetchRecordsForAccount(id: string, preserveDetails: boolean, scope: RecordScope = 'current'): Promise<WorkoutRecord[]> {
    return this.exclusive(id, async () => {
      // 避免续期与任务中的旧凭据并发；暂停/未知任务允许核对。
      if (this.store.state.tasks.some(t => t.accountId === id && ['starting', 'waiting', 'committing'].includes(t.phase)))
        throw new UserError('任务进行中，请先暂停再查记录。');
      const a = this.account(id); await this.preflight(a);
      const records = await this.client(a).records(a, () => this.store.save(), scope);
      const fetchedAt = Date.now(), prev = this.recordCache.get(id), validPrev = prev && prev.identity === identity(a) && prev.sessionId === a.session!.id ? prev : undefined;
      const details = new Map<string, RecordDetail>();
      if (validPrev) {
        if (scope === 'archive') {
          for (const [k, v] of validPrev.details) {
            if (!records.some(r => r.sportId === k) || preserveDetails) details.set(k, v);
          }
        } else if (preserveDetails) {
          for (const [k, v] of validPrev.details) {
            const oldRec = validPrev.records.find(x => x.sportId === k), newRec = records.find(x => x.sportId === k);
            if (!oldRec || (newRec && oldRec.isValid === newRec.isValid && oldRec.checkStatus === newRec.checkStatus && oldRec.inValidReason === newRec.inValidReason)) {
              details.set(k, v);
            }
          }
        } else {
          const currentIds = new Set(validPrev.records.map(x => x.sportId));
          for (const [k, v] of validPrev.details) if (!currentIds.has(k) && !records.some(x => x.sportId === k)) details.set(k, v);
        }
      }
      if (scope === 'archive') {
        this.recordCache.set(id, {
          identity: identity(a),
          sessionId: a.session!.id,
          fetchedAt: validPrev?.fetchedAt ?? 0,
          records: validPrev ? validPrev.records : [],
          archiveFetchedAt: fetchedAt,
          archiveRecords: structuredClone(records),
          details,
        });
      } else {
        this.recordCache.set(id, {
          identity: identity(a),
          sessionId: a.session!.id,
          fetchedAt,
          records: structuredClone(records),
          ...(validPrev?.archiveRecords ? { archiveFetchedAt: validPrev.archiveFetchedAt, archiveRecords: validPrev.archiveRecords } : {}),
          details,
        });
        this.syncAccountAudits(id, fetchedAt, records);
      }
      this.persistRecordCache(a);
      recordActivity(this.store.state, 'records', { accountId: id, count: records.length, level: 'ok' }); return records;
    });
  }
  cachedRecords(id: string, scope?: RecordScope | null) {
    const resolvedScope = scope ?? 'current';
    const a = this.account(id), cache = this.recordCache.get(id);
    if (!cache || cache.identity !== identity(a) || cache.sessionId !== a.session?.id) return undefined;
    if (resolvedScope === 'archive') {
      return cache.archiveFetchedAt && cache.archiveRecords
        ? { records: structuredClone(cache.archiveRecords), fetchedAt: cache.archiveFetchedAt }
        : undefined;
    }
    return cache.fetchedAt ? { records: structuredClone(cache.records), fetchedAt: cache.fetchedAt } : undefined;
  }
  async information(id: string, refresh = false): Promise<AccountInformation> {
    if (!refresh) { const old = cachedInformation(this.account(id)); if (!old?.fetchedAt) throw new UserError('暂无概览缓存，按 R 刷新。'); return old; }
    return this.exclusive(id, async () => {
      this.assertReadingAllowed(id);
      const a = this.account(id), protocol = this.client(a), session = protocol.session(a), now = Date.now();
      const old = a.information;
      const last = this.informationAttempts.get(id) ?? (old?.identity === identity(a) && old.sessionId === session.id ? old.fetchedAt : undefined);
      if (last !== undefined && now - last < 60_000) throw new UserError('请间隔 60 秒再刷新概览。');
      this.informationAttempts.set(id, now);
      await this.preflight(a); a.information = await fetchInformation(a, protocol.fetch);
      const info = a.information, count = [info.clock, info.terms, info.totals, info.statistics].filter(r => r.data !== undefined).length;
      if (count === 0 && info.clock.code === 2003) this.informationAttempts.set(id, 0);
      recordActivity(this.store.state, 'information', { accountId: id, count, level: count === 4 ? 'ok' : 'warn' }); return info;
    });
  }
  async schoolInformation(id: string, refresh = false): Promise<AccountInformation> {
    if (!refresh) { const old = cachedInformation(this.account(id)); if (!old?.schoolFetchedAt) throw new UserError('暂无学校资料缓存，按 R 刷新。'); return old; }
    return this.exclusive(id, async () => {
      this.assertReadingAllowed(id); const a = this.account(id), protocol = this.client(a), session = protocol.session(a), now = Date.now(), old = a.information;
      const stamp = old?.identity === identity(a) && old.sessionId === session.id ? old.schoolFetchedAt : undefined;
      const last = this.schoolAttempts.get(id) ?? stamp; if (last !== undefined && now - last < 60_000) throw new UserError('请间隔 60 秒再刷新学校资料。');
      this.schoolAttempts.set(id, now); await this.preflight(a); a.information = await fetchInformation(a, protocol.fetch, 'school');
      const count = [a.information.rules, a.information.reasons, a.information.deviceLimits].filter(r => r?.data !== undefined).length;
      if (count === 0 && a.information.rules.code === 2003) this.schoolAttempts.set(id, 0);
      recordActivity(this.store.state, 'school-information', { accountId: id, count, level: count === 3 ? 'ok' : 'warn' }); return a.information;
    });
  }
  async schoolNotices(id: string, refresh = false): Promise<AccountInformation> {
    if (!refresh) {
      const old = cachedInformation(this.account(id));
      if (!old?.noticesFetchedAt) throw new UserError('暂无学校通知缓存，按 R 刷新。');
      return old;
    }
    return this.exclusive(id, async () => {
      this.assertReadingAllowed(id);
      const a = this.account(id), protocol = this.client(a), session = protocol.session(a), now = Date.now(), old = a.information;
      const stamp = old?.identity === identity(a) && old.sessionId === session.id ? old.noticesFetchedAt : undefined;
      const last = this.noticeAttempts.get(id) ?? stamp;
      if (last !== undefined && now - last < 30_000) throw new UserError('请间隔 30 秒再刷新学校通知。');
      this.noticeAttempts.set(id, now);
      await this.preflight(a);
      let next = await fetchSchoolNotices(a, protocol.fetch);
      if (!next.notices?.data && next.notices?.code === 2003) {
        await protocol.renew(a);
        await this.store.save();
        next = await fetchSchoolNotices(a, protocol.fetch);
      }
      a.information = next;
      const count = next.notices?.data?.length ?? 0;
      recordActivity(this.store.state, 'school-notices', { accountId: id, count, level: next.notices?.data ? 'ok' : 'warn' });
      return a.information;
    });
  }
  async noticeDetail(id: string, noticeId: string, refresh = false): Promise<string[]> {
    return this.exclusive(id, async () => {
      this.assertReadingAllowed(id);
      const a = this.account(id), info = cachedInformation(a);
      const notice = info?.notices?.data?.find(n => n.id === noticeId);
      if (!notice) throw new UserError('未找到该条通知，请先按 R 刷新学校通知。');
      if (notice.url && (refresh || !notice.body?.length)) {
        const protocol = this.client(a);
        protocol.session(a);
        await this.preflight(a);
        const fetched = await fetchNoticeArticle(a, protocol.fetch, notice.url);
        if (fetched?.length) notice.body = fetched;
      }
      const en = this.store.state.settings.language === 'en';
      const lines: string[] = en
        ? [
            `${notice.forced ? '[URGENT] ' : ''}${notice.title}`,
            ...(notice.date ? [`Published  ${notice.date}`] : []),
            ...(notice.remindWindow ? [`Window     ${notice.remindWindow}`] : []),
            '',
            ...(notice.summary ? [notice.summary, ''] : []),
            ...(notice.body?.length ? [...notice.body, ''] : []),
            ...(notice.url ? [`Source URL ${notice.url}`] : []),
          ]
        : [
            `${notice.forced ? '[重要] ' : ''}${notice.title}`,
            ...(notice.date ? [`发布时间  ${notice.date}`] : []),
            ...(notice.remindWindow ? [`提醒时段  ${notice.remindWindow}`] : []),
            '',
            ...(notice.summary ? [notice.summary, ''] : []),
            ...(notice.body?.length ? [...notice.body, ''] : []),
            ...(notice.url ? [`原文链接  ${notice.url}`] : []),
          ];
      if (!notice.summary && !notice.body?.length) {
        lines.push(
          en
            ? notice.url
              ? 'External bulletin — open the URL above in a browser for full content.'
              : 'No additional body content.'
            : notice.url
              ? '该通知为外部网页或富媒体公告，可在浏览器打开上方链接查看完整内容。'
              : '暂无更多正文内容。',
        );
      }
      return lines;
    });
  }
  async recordDetail(id: string, sportId: string, refresh = false) { return this.exclusive(id, async () => {
    this.assertReadingAllowed(id);
    const a = this.account(id), protocol = this.client(a), session = protocol.session(a), cache = this.recordCache.get(id);
    const valid = cache?.identity === identity(a) && cache.sessionId === session.id ? cache : undefined;
    const record = valid?.records.find(r => r.sportId === sportId) ?? valid?.archiveRecords?.find(r => r.sportId === sportId);
    if (!record) throw new UserError('请先刷新此账号的记录列表，再查看详情。');
    const previous = valid!.details.get(sportId); if (!refresh && previous) return structuredClone(previous);
    await this.preflight(a); const detail = await fetchRecordDetail(a, protocol.fetch, record);
    if (valid!.details.size >= 100) valid!.details.delete(valid!.details.keys().next().value!);
    valid!.details.set(sportId, structuredClone(detail));
    this.persistRecordCache(a);
    recordActivity(this.store.state, 'detail', { accountId: id, level: 'ok' }); return detail;
  }); }
  private assertReadingAllowed(id: string) {
    if (this.store.state.tasks.some(t => t.accountId === id && ['starting', 'waiting', 'committing'].includes(t.phase)))
      throw new UserError('任务进行中，请先暂停再查询。');
  }
  private persistRecordCache(a: Account) {
    const cache = this.recordCache.get(a.id);
    if (!cache || cache.identity !== identity(a) || cache.sessionId !== a.session?.id) {
      a.recordCache = undefined;
      return;
    }
    const details: Record<string, RecordDetail> = {};
    let count = 0;
    for (const [k, v] of cache.details) {
      if (count++ >= 40) break;
      details[k] = structuredClone(v);
    }
    a.recordCache = {
      identity: cache.identity,
      sessionId: cache.sessionId,
      fetchedAt: cache.fetchedAt,
      records: structuredClone(cache.records.slice(0, 60)),
      ...(cache.archiveFetchedAt && cache.archiveRecords ? {
        archiveFetchedAt: cache.archiveFetchedAt,
        archiveRecords: structuredClone(cache.archiveRecords.slice(0, 80)),
      } : {}),
      ...(count ? { details } : {}),
    };
  }
  private syncAccountAudits(accountId: string, fetchedAt: number, records: WorkoutRecord[]) {
    for (const t of this.store.state.tasks) {
      if (t.accountId !== accountId || !['done', 'review'].includes(t.phase)) continue;
      const sid = t.session?.sportId || t.result?.sportId;
      if (!sid) continue;
      const record = records.find(r => r.sportId === sid || (t.result?.sportId && r.sportId === t.result.sportId));
      t.audit = {
        checkedAt: fetchedAt,
        found: !!record,
        record: record ? structuredClone(record) : t.audit?.record,
        recordAt: record ? fetchedAt : t.audit?.recordAt,
      };
      if (record && record.checkStatus !== '0') t.autoAuditAt = undefined;
    }
  }
  async clearSession(id: string) {
    if (this.hasTask(id) || this.operations.has(id)) throw new UserError('请先处理任务或等待请求结束。');
    return this.exclusive(id, async () => {
      const a = this.account(id);
      if (a.session) {
        await this.registry.transaction(entries => entries.observe({ ...a, deviceUsage: 'attempted' }));
        a.deviceUsage = 'attempted';
      }
      delete a.session; delete a.information; delete a.recordCache;
      this.recordCache.delete(id); this.informationAttempts.delete(id); this.schoolAttempts.delete(id); this.noticeAttempts.delete(id);
      recordActivity(this.store.state, 'session-cleared', { accountId: id });
    });
  }
  async prepare(id: string, libraryId: string, options: PrepareOptions = {}) {
    const a = this.account(id);
    const rule = a.information?.rules.data?.find(r => r.id === a.routeId);
    const prepared = await prepareOneShot(this.store, a, libraryId, options);
    if (rule) {
      const ruleWarns: string[] = [];
      if (rule.faceAuth) ruleWarns.push('该路线开启了人脸核验（当前不支持上传人脸照片，建议切换免刷脸路线）');
      if (rule.dynamicWaypoints) ruleWarns.push('该路线含动态随机点位（暂不支持，建议切换固定跑道）');
      if (rule.requiredCheckpoints) ruleWarns.push(`该路线含 ${rule.requiredCheckpoints} 个固定必过点，请确认样本完整经过`);
      if (ruleWarns.length) prepared.previewWarnings = [...ruleWarns, ...(prepared.previewWarnings ?? [])];
    }
    return prepared;
  }
  async prepareDefault(id: string, options: PrepareOptions = {}) {
    const a = this.account(id), library = this.store.state.libraries.find(l => canUse(l, a) && l.id === a.libraryId)
      ?? this.store.state.libraries.find(l => canUse(l, a));
    if (!library) throw new UserError(`${a.label} 尚未配置记录库，请在账号管理中导入。`);
    return this.prepare(id, library.id, options);
  }
  async deleteAccount(id: string) {
    this.assertWritable();
    if (this.operations.has(id) || this.store.state.tasks.some(t => t.accountId === id && activeTask(t) && t.phase !== 'queued' && !(t.phase === 'paused' && t.resumePhase === 'queued')))
      throw new UserError('账号有已开始或待核对任务，请先处理。');
    return this.exclusive(id, async () => {
      const account = this.account(id);
      await this.registry.transaction(entries => entries.verify(account));
      const libs = this.store.state.libraries.filter(l => l.scope === 'private' && l.ownerAccountId === id);
      this.store.state.accounts = this.store.state.accounts.filter(a => a.id !== id);
      this.store.state.tasks = this.store.state.tasks.filter(t => t.accountId !== id);
      this.store.state.libraries = this.store.state.libraries.filter(l => !libs.includes(l));
      this.store.state.activity = this.store.state.activity?.filter(e => e.accountId !== id);
      recordActivity(this.store.state, 'account-deleted');
      await this.store.save(); await Promise.all(libs.map(l => this.store.deleteLibrary(l.id)));
      await this.clients.get(id)?.transport.close(); this.clients.delete(id); this.recordCache.delete(id); this.informationAttempts.delete(id); this.schoolAttempts.delete(id); this.noticeAttempts.delete(id); this.emit('change');
    });
  }
  private taskAccount(t: Task) {
    const a = this.account(t.accountId), s = this.client(a).session(a);
    if (identity(a) !== t.identity || s.id !== t.sessionId || s.xh !== String(t.prepared.body.xh))
      throw new UserError('任务与当前账号或设备不匹配。');
    this.assertPreparedDevice(a, t.prepared);
    return a;
  }
  private assertPreparedDevice(a: Account, p: Prepared) {
    if ((p.deviceRevision !== undefined && p.deviceRevision !== a.deviceRevision) ||
      (p.preparedSessionId !== undefined && p.preparedSessionId !== a.session?.id) ||
      (p.accountIdentity && p.accountIdentity !== identity(a)) || p.body.phoneVersion !== phoneVersion(a.device))
      throw new UserError('方案中的设备档案已过期，请重新准备。');
  }
  private runningCount() { return this.store.state.tasks.filter(t => ['starting', 'waiting', 'committing'].includes(t.phase)).length; }
  async start(id: string, prepared: Prepared) { return this.exclusive(id, async () => {
    assertGeometry(prepared);
    const a = this.account(id), protocol = this.client(a), s = protocol.session(a);
    this.assertPreparedDevice(a, prepared);
    if (this.hasTask(id)) throw new UserError('每个账号只能有一个未处理任务。');
    if (this.runningCount() >= this.store.state.settings.maxConcurrent) throw new UserError('已达到同时运行任务上限。');
    if (!this.store.state.libraries.some(l => l.id === prepared.libraryId && canUse(l, a)) ||
      prepared.routeId !== a.routeId || String(prepared.body.routeId) !== a.routeId || String(prepared.body.xh) !== s.xh)
      throw new UserError('预览已失效或来源不可用，请重新准备。');
    const task: Task = { id: randomUUID(), accountId: id, accountLabel: a.label, identity: identity(a),
      sessionId: s.id, createdAt: Date.now(), phase: 'starting', prepared: structuredClone(prepared), note: '正在开始。' };
    this.store.state.tasks.unshift(task); await this.store.save(); this.emit('change');
    await this.execute(task, 'begin'); return task;
  }); }
  async queuePrepared(id: string, prepared: Prepared, firstStartAt: number) {
    return this.exclusive(id, async () => {
      if (!Number.isFinite(firstStartAt) || firstStartAt < Date.now() - 10_000) throw new UserError('开始时间无效。');
      assertGeometry(prepared); const a = this.account(id), s = this.client(a).session(a);
      this.assertPreparedDevice(a, prepared);
      if (this.hasTask(id)) throw new UserError('每个账号只能有一个未处理任务。');
      if (!this.store.state.libraries.some(l => l.id === prepared.libraryId && canUse(l, a)) || prepared.routeId !== a.routeId ||
        String(prepared.body.routeId) !== a.routeId || String(prepared.body.xh) !== s.xh) throw new UserError('预览已失效，请重新准备。');
      const task: Task = { id: randomUUID(), accountId: id, accountLabel: a.label, identity: identity(a), sessionId: s.id,
        createdAt: Date.now(), phase: 'queued', prepared: structuredClone(prepared), plannedStartAt: firstStartAt, note: '等待开始。' };
      this.store.state.tasks.unshift(task); this.armed.add(task.id);
      recordActivity(this.store.state, 'plan', { count: 1 });
      await this.store.save(); return task;
    });
  }
  async queuePlan(accountIds: string[], firstStartAt: number, staggerMs: number, options: PrepareOptions = {}) {
    this.assertWritable();
    if (this.planning) throw new UserError('正在保存计划，请稍候。');
    const unique = [...new Set(accountIds)];
    if (!unique.length) throw new UserError('请至少选择一个账号。');
    if (!Number.isFinite(firstStartAt) || firstStartAt < Date.now() - 10_000 || !Number.isFinite(staggerMs) || staggerMs < 0)
      throw new UserError('计划时间参数无效。');
    this.planning = true;
    try {
      const entries: Array<{ a: Account; prepared: Prepared; sessionId: string; identity: string }> = [];
      for (const id of unique) {
        const a = this.account(id);
        if (this.hasTask(id) || this.operations.has(id)) throw new UserError(`${a.label} 已有未处理任务或进行中的操作。`);
        const s = this.client(a).session(a), boundIdentity = identity(a);
        const prepared = await this.prepareDefault(id, options); assertGeometry(prepared);
        entries.push({ a, prepared, sessionId: s.id, identity: boundIdentity });
      }
      // 准备期间再次检查，避免异步读库后覆盖新任务/配置。
      for (const e of entries) {
        if (!this.store.state.accounts.includes(e.a) || this.hasTask(e.a.id) || this.operations.has(e.a.id) ||
          identity(e.a) !== e.identity || e.a.session?.id !== e.sessionId)
          throw new UserError('账号配置已变化，请重新准备计划。');
        this.assertPreparedDevice(e.a, e.prepared);
        this.client(e.a).session(e.a);
      }
      const tasks = entries.map((e, i): Task => ({ id: randomUUID(), accountId: e.a.id, accountLabel: e.a.label,
        identity: e.identity, sessionId: e.sessionId, createdAt: Date.now(), phase: 'queued', prepared: e.prepared,
        plannedStartAt: firstStartAt + i * staggerMs, note: '等待开始。' }));
      this.store.state.tasks.unshift(...tasks); for (const t of tasks) this.armed.add(t.id);
      recordActivity(this.store.state, 'plan', { count: tasks.length });
      await this.store.save(); this.emit('change'); return tasks;
    } finally { this.planning = false; }
  }
  private async execute(t: Task, stage: 'begin' | 'commit') {
    try {
      assertGeometry(t.prepared);
      const a = this.taskAccount(t), protocol = this.client(a);
      await this.preflight(a); await this.store.save();
      const s = protocol.session(a), expireAt = Number(s.loginOutTime);
      if (stage === 'begin' && Number.isFinite(expireAt) && expireAt > 0 && expireAt - Date.now() < 6 * 3600_000) { await protocol.renew(a); await this.store.save(); }
      // 只保存端点、时间、状态码；不沿用旧的 URL/响应正文日志。
      const taskFetch: typeof fetch = async (url, init) => {
        const endpoint = new URL(String(url)).pathname.split('/').at(-1) ?? 'request';
        const response = await protocol.fetch(url, init);
        let code: number | undefined;
        try { const json = await response.clone().json() as { code?: unknown }; if (typeof json.code === 'number') code = json.code; } catch { /* 交由原流程处理非法响应 */ }
        (t.steps ??= []).push({ endpoint, at: Date.now(), httpStatus: response.status, code });
        if (response.ok && code === 2001) s.status = 'invalid';
        await this.store.save();
        if (!response.ok) throw new UserError(`${endpoint} HTTP ${response.status}，请求失败。`);
        return response;
      };
      const runSubmit = () => handleScheduledSubmit({
        body: t.prepared.body, sensorArray: t.prepared.sensor, sportTypeId: t.prepared.routeId,
        startAtMs: t.session?.startAtMs ?? 0, stage, session: t.session, timezoneOffsetMin: 480,
        mode: 'submit', validate: true, wait: this.mock ? async () => {} : undefined,
        config: { baseUrl: a.school.baseUrl, token: s.token,
          secret: s.secret, signer: 'native', imei: deviceHeaders(a.device).imei, version: '', client: '',
          session: { ...deviceHeaders(a.device), v1: '', client: '' } },
      }, { fetchImpl: taskFetch, allowedOrigins: new Set([new URL(BASE).origin, new URL(a.school.baseUrl).origin]), audit: false });
      let result = await runSubmit();
      if (!result.ok && stage === 'begin' && t.steps?.length === 1 && t.steps[0]?.endpoint === 'inSportTime' && t.steps[0]?.code === 2003) {
        await protocol.renew(a); await this.store.save(); result = await runSubmit();
      }
      if (!result.ok) { t.phase = 'review'; t.note = `${safeText(result.error, 160)}`; return; }
      if (stage === 'begin') {
        if (!result.scheduledSession) throw new UserError('开始响应缺少任务锚点。');
        t.session = result.scheduledSession; t.phase = 'waiting'; this.armed.add(t.id);
        t.note = '等待提交。';
      } else {
        t.phase = 'done'; this.armed.delete(t.id);
        t.result = { accepted: true, businessValid: result.businessValid, sportId: result.sportId,
          code: result.save?.code, isValid: result.save?.isValid, checkStatus: result.save?.checkStatus,
          reason: result.save?.inValidReason };
        if (!result.businessValid && (result.save?.checkStatus === '0' || !result.save?.inValidReason)) {
          t.autoAuditAt = Date.now() + AUTO_AUDIT_DELAY_MS;
        }
        t.note = '提交完成。';
      }
    } catch (e) {
      t.phase = 'review'; this.armed.delete(t.id);
      t.note = e instanceof UserError ? e.message : '提交中断，按 C 查看结果。';
    } finally { recordActivity(this.store.state, 'task', { accountId: t.accountId, phase: t.phase, level: t.phase === 'review' ? 'warn' : 'info' }); await this.store.save(); this.emit('change'); }
  }
  async tick() {
    if (this.ticking || this.restoring || this.store.state.pendingBindings) return; this.ticking = true;
    try {
      const now = Date.now();
      const due = this.store.state.tasks.filter(t => t.phase === 'waiting' && this.armed.has(t.id) &&
        now >= (t.session?.commitAtLocalMs ?? t.session?.endAtMs ?? Infinity));
      await Promise.allSettled(due.map(t => this.exclusive(t.accountId, async () => {
        const target = t.session?.commitAtLocalMs ?? t.session?.endAtMs ?? 0;
        if (Date.now() - target > 90_000) { t.phase = 'review'; t.note = '已错过提交时间，按 C 查看记录。'; return; }
        t.phase = 'committing'; this.armed.delete(t.id); await this.store.save(); this.emit('change');
        await this.execute(t, 'commit');
      })));
      const queued = this.store.state.tasks.filter(t => t.phase === 'queued' && this.armed.has(t.id) && (t.plannedStartAt ?? Infinity) <= Date.now())
        .sort((a, b) => (a.plannedStartAt ?? 0) - (b.plannedStartAt ?? 0));
      for (const t of queued) {
        if (this.runningCount() >= this.store.state.settings.maxConcurrent) break;
        if (this.operations.has(t.accountId)) continue;
        t.phase = 'starting'; await this.store.save(); this.emit('change');
        await this.exclusive(t.accountId, () => this.execute(t, 'begin'));
      }
      // 单次延迟静默复核：仅针对异步待审核任务触发一次只读 sportlist，绝不循环轮询。
      const dueAudits = this.store.state.tasks.filter(
        t => t.phase === 'done' && t.autoAuditAt !== undefined && t.autoAuditAt <= Date.now(),
      );
      const auditedAccounts = new Set<string>();
      for (const t of dueAudits) {
        if (this.operations.has(t.accountId) || this.store.state.tasks.some(x => x.accountId === t.accountId && ['starting', 'waiting', 'committing'].includes(x.phase))) {
          continue;
        }
        t.autoAuditAt = undefined;
        if (auditedAccounts.has(t.accountId)) { await this.store.save(); continue; }
        auditedAccounts.add(t.accountId);
        try {
          await this.fetchRecordsForAccount(t.accountId, true, 'current');
        } catch {
          await this.store.save();
        }
      }
    } finally { this.ticking = false; }
  }
  async resume(id: string) {
    const t = this.store.state.tasks.find(t => t.id === id);
    if (!t || t.phase !== 'paused' || (!t.session && t.resumePhase !== 'queued')) throw new UserError('只能恢复已暂停任务；其他任务请先核对结果。');
    if (t.resumePhase !== 'queued' && this.runningCount() >= this.store.state.settings.maxConcurrent) throw new UserError('已达到并发上限。');
    return this.exclusive(t.accountId, async () => {
      const a = this.taskAccount(t);
      if (t.resumePhase === 'queued') { t.phase = 'queued'; t.plannedStartAt = Math.max(Date.now(), t.plannedStartAt ?? 0); this.armed.add(t.id); return; }
      const target = t.session!.commitAtLocalMs ?? t.session!.endAtMs;
      if (Date.now() - target > 90_000) throw new UserError('已错过提交时间，请查看记录。');
      await this.preflight(a); t.phase = 'waiting'; this.armed.add(t.id); t.note = '已恢复，等待提交。';
    });
  }
  async pause(id: string) {
    const t = this.store.state.tasks.find(t => t.id === id);
    if (!t || !['queued', 'waiting'].includes(t.phase)) throw new UserError('仅能暂停排队或等待任务。');
    t.resumePhase = t.phase as 'queued' | 'waiting'; this.armed.delete(t.id); t.phase = 'paused';
    t.note = t.resumePhase === 'queued' ? '计划已暂停。' : '任务已暂停。';
    recordActivity(this.store.state, 'task', { accountId: t.accountId, phase: t.phase }); await this.store.save();
  }
  async archive(id: string) {
    const t = this.store.state.tasks.find(t => t.id === id);
    if (!t || ['starting', 'waiting', 'committing'].includes(t.phase)) throw new UserError('请先等待请求结束或暂停任务。');
    t.phase = 'abandoned'; t.autoAuditAt = undefined; t.note = '已归档。'; recordActivity(this.store.state, 'task', { accountId: t.accountId, phase: t.phase }); await this.store.save();
  }
  async fastForwardDemo(id: string) {
    if (!this.mock) throw new UserError('快进只用于完全离线演示。');
    const t = this.store.state.tasks.find(t => t.id === id);
    if (!t?.session || t.phase !== 'waiting') throw new UserError('请先在演示账号里开始一个任务。');
    t.session.startAtMs = Date.now() - t.prepared.durationSec * 1000 - 1000;
    t.session.endAtMs = Date.now() - 1000; t.session.commitAtLocalMs = Date.now() - 100;
    await this.tick();
  }
  async shutdown() {
    if (this.operations.size || this.planning || this.ticking) throw new UserError('正在处理，请稍候再退出。');
    this.phoneCandidates.clear();
    for (const t of this.store.state.tasks) if (t.phase === 'waiting' || t.phase === 'queued') { t.resumePhase = t.phase; t.phase = 'paused'; t.note = '任务已暂停，按 R 恢复。'; }
    await this.store.save(); await this.store.flush();
    await Promise.allSettled([...this.clients.values()].map(c => c.transport.close())); this.store.close();
  }
  async stopBackground() { await this.shutdown(); }
}
