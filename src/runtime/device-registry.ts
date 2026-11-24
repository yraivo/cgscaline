import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { accountKey, sameDevice, validDevice, type Binding, type BindingChange } from '../core/device-identity.js';
import { canonicalDevice, deviceHeaders, deviceUsage, UserError, type Account, type Device, type DeviceSource, type DeviceUsage } from '../core/model.js';
import { WindowsVault, type Store, type Vault } from './storage.js';

export class BindingConflict extends UserError {
  constructor() { super('设备标识冲突或绑定已更新。请核对档案后重新选择设备。'); }
}

function conflicts(a: Device, b: Device) {
  return a.androidId.toLowerCase() === b.androidId.toLowerCase() || deviceHeaders(a).imei === deviceHeaders(b).imei;
}
function mergedUsage(a: DeviceUsage, b: DeviceUsage): DeviceUsage {
  if (a === 'attempted' || b === 'attempted') return 'attempted';
  return a === 'unknown' || b === 'unknown' ? 'unknown' : 'unused';
}
export function applyBinding(a: Account, entry: Binding) {
  delete a.bindingConflict;
  a.device = canonicalDevice(entry.device);
  a.deviceRevision = entry.version;
  a.deviceUsage = entry.usage;
  a.deviceSource = entry.source;
}

/** All methods run on a private snapshot under the registry writer lock. */
export class Bindings {
  constructor(readonly entries: Binding[], private ephemeral = false) {}
  get(a: Pick<Account, 'school' | 'username'>) { return this.entries.find(e => e.key === accountKey(a)); }
  private insert(a: Account, source: DeviceSource) {
    if (!validDevice(a.device)) throw new UserError('设备字段格式错误。');
    const entry: Binding = { key: accountKey(a), tenantId: a.school.id, device: canonicalDevice(a.device), source, usage: deviceUsage(a),
      version: 1, updatedAt: Date.now(), alternatives: [] };
    this.entries.push(entry);
    return entry;
  }
  observe(a: Account) {
    const existing = this.get(a);
    if (!existing && !this.ephemeral && a.deviceRevision !== undefined) throw new BindingConflict();
    const entry = existing ?? this.insert(a, a.deviceSource ?? 'existing');
    if (!existing && this.ephemeral && a.deviceRevision) entry.version = a.deviceRevision;
    if (!sameDevice(entry.device, a.device)) {
      // An unversioned vault is independent evidence. A stale versioned vault is not.
      if (!a.deviceRevision && !entry.alternatives.some(d => sameDevice(d, a.device))) {
        if (!validDevice(a.device)) throw new UserError('设备字段格式错误。');
        entry.alternatives.push(canonicalDevice(a.device));
        entry.version++;
        entry.updatedAt = Date.now();
      }
    }
    entry.usage = mergedUsage(entry.usage, deviceUsage(a));
    return entry;
  }
  private assertAvailable(key: string, device: Device) {
    if (this.entries.some(e => e.key !== key && [e.device, ...e.alternatives].some(d => conflicts(device, d))))
      throw new BindingConflict();
  }
  create(a: Account) {
    const existing = this.get(a);
    this.assertAvailable(accountKey(a), existing?.device ?? a.device);
    const entry = existing ?? this.insert(a, a.deviceSource ?? 'tui');
    if (entry.alternatives.length) throw new BindingConflict();
    if (!entry.tenantId && a.school.id) {
      entry.tenantId = a.school.id;
      entry.version++;
      entry.updatedAt = Date.now();
    }
    if (entry.tenantId !== a.school.id) throw new BindingConflict();
    return entry;
  }
  stagePhone(key: string, tenantId: string, device: Device) {
    if (!validDevice(device)) throw new UserError('设备字段格式错误。');
    this.assertAvailable(key, device);
    const existing = this.entries.find(e => e.key === key);
    if (!existing) {
      const entry: Binding = { key, tenantId, device: canonicalDevice(device), source: 'phone', usage: 'unused',
        version: 1, updatedAt: Date.now(), alternatives: [] };
      this.entries.push(entry);
      return entry;
    }
    if (existing.alternatives.length || (existing.tenantId && tenantId && existing.tenantId !== tenantId)) throw new BindingConflict();
    if (sameDevice(existing.device, device)) {
      if (existing.source !== 'phone' || (!existing.tenantId && tenantId)) {
        existing.source = 'phone';
        if (!existing.tenantId && tenantId) existing.tenantId = tenantId;
        existing.version++;
        existing.updatedAt = Date.now();
      }
      return existing;
    }
    if (existing.usage !== 'unused') throw new BindingConflict();
    existing.device = canonicalDevice(device);
    existing.source = 'phone';
    if (!existing.tenantId && tenantId) existing.tenantId = tenantId;
    existing.version++;
    existing.updatedAt = Date.now();
    return existing;
  }
  verify(a: Account, attempted = false) {
    const entry = this.get(a) ?? this.observe(a);
    if (entry.tenantId !== a.school.id || !sameDevice(a.device, entry.device) || entry.alternatives.length ||
      (a.deviceRevision !== undefined && a.deviceRevision !== entry.version)) throw new BindingConflict();
    this.assertAvailable(entry.key, entry.device);
    entry.usage = mergedUsage(entry.usage, attempted ? 'attempted' : deviceUsage(a));
    return entry;
  }
  retagTenant(a: Account, target: Account) {
    const entry = this.verify(a);
    if (accountKey(a) !== accountKey(target) || !sameDevice(a.device, target.device)) throw new BindingConflict();
    entry.tenantId = target.school.id;
    entry.version++;
    entry.updatedAt = Date.now();
    return entry;
  }
  acceptRegistered(a: Account, version: number) {
    const entry = this.get(a);
    if (!entry || entry.tenantId !== a.school.id || entry.version !== version) throw new BindingConflict();
    this.assertAvailable(entry.key, entry.device);
    if (entry.alternatives.length) {
      entry.alternatives = [];
      entry.version++;
      entry.updatedAt = Date.now();
    }
    return entry;
  }
  replace(a: Account, device: Device, source: DeviceSource, unusedOnly = false) {
    if (!validDevice(device)) throw new UserError('设备字段格式错误。');
    const entry = this.get(a) ?? this.observe(a);
    if (entry.tenantId !== a.school.id || (a.deviceRevision !== undefined && a.deviceRevision !== entry.version) ||
      (!sameDevice(a.device, entry.device) && !entry.alternatives.some(d => sameDevice(d, a.device)))) throw new BindingConflict();
    if (unusedOnly && (entry.usage !== 'unused' || entry.alternatives.length)) throw new BindingConflict();
    this.assertAvailable(entry.key, device);
    if (!sameDevice(entry.device, device) || entry.alternatives.length) {
      entry.device = canonicalDevice(device);
      entry.alternatives = [];
      entry.source = source;
      entry.version++;
      entry.updatedAt = Date.now();
    }
    return entry;
  }
}
type Prepare<T> = (result: T, changes: BindingChange[]) => Promise<void>;
function changesSince(before: Binding[], after: Binding[]): BindingChange[] {
  const byKey = new Map(before.map(entry => [entry.key, entry]));
  return after.flatMap(entry => {
    const old = byKey.get(entry.key);
    return JSON.stringify(old) === JSON.stringify(entry) ? [] : [{ before: old, after: entry }];
  });
}
export interface DeviceRegistry {
  transaction<T>(operation: (bindings: Bindings) => T, prepare?: Prepare<T>): Promise<T>;
}
export class MemoryDeviceRegistry implements DeviceRegistry {
  private entries: Binding[] = [];
  private queue = Promise.resolve();
  transaction<T>(operation: (bindings: Bindings) => T, prepare?: Prepare<T>) {
    const job = this.queue.then(async () => {
      const copy = structuredClone(this.entries);
      const result = operation(new Bindings(copy, true));
      if (prepare) await prepare(result, changesSince(this.entries, copy));
      this.entries = copy;
      return structuredClone(result);
    });
    this.queue = job.then(() => {}, () => {});
    return job;
  }
}
function decode(bytes: Buffer): Binding[] {
  const payload = JSON.parse(bytes.toString('utf8'));
  if (payload.schema !== 1 || !Array.isArray(payload.entries)) throw new Error('schema');
  const seen = new Set<string>();
  for (const entry of payload.entries as Binding[]) {
    if (typeof entry.key !== 'string' || typeof entry.tenantId !== 'string' || seen.has(entry.key) || !validDevice(entry.device) ||
      !Number.isSafeInteger(entry.version) || entry.version < 1 || !Number.isFinite(entry.updatedAt) ||
      !['tui', 'manual', 'portable', 'existing', 'phone'].includes(entry.source) ||
      !['attempted', 'unknown', 'unused'].includes(entry.usage) ||
      !Array.isArray(entry.alternatives) || !entry.alternatives.every(validDevice)) throw new Error('entry');
    seen.add(entry.key);
  }
  return payload.entries;
}
export class FileDeviceRegistry implements DeviceRegistry {
  constructor(private directory: string, private vault: Vault = new WindowsVault()) {}
  async transaction<T>(operation: (bindings: Bindings) => T, prepare?: Prepare<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    // SQLite owns the OS lock on this separate, data-free file. Process death releases it.
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const lock = new sqlite.DatabaseSync(join(this.directory, 'device-registry.lock'));
    const path = join(this.directory, 'device-registry.dpapi');
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        try { lock.exec('BEGIN IMMEDIATE'); break; }
        catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
          await delay(25);
        }
      }
      let encrypted: Buffer | undefined;
      try { encrypted = await readFile(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const marker = lock.prepare('PRAGMA user_version').get()?.user_version;
      if ((marker !== 0 && marker !== 1) || (marker === 1 && !encrypted))
        throw new UserError('设备注册表缺失或版本无效，请恢复原注册表。');
      let entries: Binding[];
      try { entries = encrypted ? decode(await this.vault.unprotect(encrypted)) : []; }
      catch { throw new UserError('设备注册表无法解密或已损坏，请恢复原注册表。'); }
      const before = JSON.stringify(entries);
      const result = operation(new Bindings(entries));
      if (prepare) await prepare(result, changesSince(JSON.parse(before), entries));
      if (before !== JSON.stringify(entries)) {
        const temp = path + '.' + randomUUID() + '.tmp';
        try {
          const data = await this.vault.protect(Buffer.from(JSON.stringify({ schema: 1, entries })));
          await writeFile(temp, data, { flag: 'wx', mode: 0o600, flush: true });
          await rename(temp, path);
        } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      }
      if (marker === 0 && (encrypted || entries.length)) lock.exec('PRAGMA user_version = 1');
      lock.exec('COMMIT');
      return result;
    } finally { lock.close(); }
  }
}
export function registryForWorker(demo: boolean, localAppData = process.env.LOCALAPPDATA): DeviceRegistry {
  if (demo) return new MemoryDeviceRegistry();
  if (!localAppData) throw new UserError('无法定位 Windows 用户数据目录。');
  return new FileDeviceRegistry(join(localAppData, 'CGSPORT'));
}

const committing = new WeakSet<Store>();

/** The vault commits its final state and redo intent before the registry replace, under the same writer lock. */
export async function commitBindings<T>(store: Store, registry: DeviceRegistry, operation: (bindings: Bindings) => T,
  stage: (result: T) => void | Promise<void>) {
  if (committing.has(store) || store.state.pendingBindings) throw new UserError('设备绑定仍待恢复，请稍后重试。');
  committing.add(store);
  try {
    await registry.transaction(operation, async (result, changes) => {
      if (store.state.pendingBindings) throw new UserError('设备绑定仍待恢复，请重新打开档案。');
      await stage(result);
      if (changes.length) store.state.pendingBindings = changes;
      await store.save();
    });
    if (store.state.pendingBindings) {
      delete store.state.pendingBindings;
      await store.save();
    }
  } finally { committing.delete(store); }
}

export async function recoverBindings(store: Store, registry: DeviceRegistry) {
  const pending = store.state.pendingBindings;
  if (!pending) return;
  await registry.transaction(table => {
    for (const { before, after } of pending) {
      const existing = table.entries.find(e => e.key === after.key);
      if (existing && existing.tenantId === after.tenantId && existing.version === after.version && sameDevice(existing.device, after.device) &&
        JSON.stringify(existing.alternatives) === JSON.stringify(after.alternatives)) {
        existing.usage = mergedUsage(existing.usage, after.usage);
        continue;
      }
      if (JSON.stringify(existing) !== JSON.stringify(before)) throw new BindingConflict();
      if (table.entries.some(e => e.key !== after.key && [e.device, ...e.alternatives].some(d => conflicts(d, after.device))))
        throw new BindingConflict();
      if (existing) Object.assign(existing, structuredClone(after));
      else table.entries.push(structuredClone(after));
    }
  });
  delete store.state.pendingBindings;
  await store.save();
}
