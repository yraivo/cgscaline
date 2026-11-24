import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { accountKey, deviceConflicts, sameDevice, validDevice } from '../core/device-identity.js';
import { activeTask, deviceUsage, migrateIdentity, identity, canUseLibrary, UserError, type Account, type Library, type State } from '../core/model.js';
import { applyBinding, BindingConflict, commitBindings, type Bindings, type DeviceRegistry } from './device-registry.js';
import type { Store } from './storage.js';

const AAD = Buffer.from('CGSCALINE-BACKUP-V1', 'utf8');
const ITERATIONS = 210_000;
const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

interface BackupEnvelope {
  format: 'cgscaline-backup';
  version: 1;
  kdf: 'pbkdf2-sha512';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface BackupPayload {
  exportedAt: number;
  includeSessions: boolean;
  settings: Partial<State['settings']>;
  accounts: Account[];
  libraries: Array<{ meta: Library; data: unknown }>;
}

export interface ExportBackupResult {
  path: string;
  accounts: number;
  libraries: number;
  includeSessions: boolean;
}

export interface ImportBackupResult {
  accountsAdded: number;
  accountsUpdated: number;
  librariesAdded: number;
  conflicts: string[];
  sessionsSkipped: number;
}

function validatePassphrase(passphrase: string) {
  if (typeof passphrase !== 'string' || passphrase.length < 6 || passphrase.length > 256)
    throw new UserError('备份口令长度需为 6–256 个字符。');
}

export async function exportPortableBackup(
  store: Store,
  filePath: string,
  passphrase: string,
  includeSessions = true,
): Promise<ExportBackupResult> {
  validatePassphrase(passphrase);
  const trimmed = filePath.trim();
  if (!trimmed) throw new UserError('请填写导出文件路径。');
  if (store.state.tasks.some(t => ['starting', 'waiting', 'committing'].includes(t.phase)))
    throw new UserError('有正在执行的任务，请先暂停或等待完成后再导出。');

  const target = resolve(trimmed.endsWith('.cgsbak') ? trimmed : `${trimmed}.cgsbak`);
  const libraries: Array<{ meta: Library; data: unknown }> = [];
  for (const lib of store.state.libraries) {
    const data = await store.getLibrary(lib.id);
    if (data !== undefined) libraries.push({ meta: structuredClone(lib), data });
  }

  const accounts = store.state.accounts.map(raw => {
    const copy = structuredClone(raw);
    copy.deviceUsage = deviceUsage(copy);
    delete copy.deviceRevision;
    delete copy.compatibility;
    if (!includeSessions) {
      delete copy.session;
      delete copy.recordCache;
      delete copy.information;
    } else if (copy.session && copy.session.status === 'verified') {
      copy.session.status = 'saved';
    }
    return copy;
  });

  const { compatibility: _compat, ...settings } = structuredClone(store.state.settings);
  void _compat;

  const payload: BackupPayload = {
    exportedAt: Date.now(),
    includeSessions,
    settings,
    accounts,
    libraries,
  };

  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 6 });
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, ITERATIONS, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);

  const envelope: BackupEnvelope = {
    format: 'cgscaline-backup',
    version: 1,
    kdf: 'pbkdf2-sha512',
    iterations: ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(envelope), { flag: 'wx', mode: 0o600, flush: true });
    await rename(temp, target);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e instanceof UserError ? e : new UserError('写入加密备份包失败，请检查目录权限与路径。');
  }

  return { path: target, accounts: accounts.length, libraries: libraries.length, includeSessions };
}

export async function importPortableBackup(
  store: Store,
  filePath: string,
  passphrase: string,
  registry: DeviceRegistry,
): Promise<ImportBackupResult> {
  validatePassphrase(passphrase);
  const trimmed = filePath.trim();
  if (!trimmed) throw new UserError('请填写备份包路径。');
  if (store.state.tasks.some(t => activeTask(t)))
    throw new UserError('请先处理或暂停当前未结束任务，再导入备份包。');

  const target = resolve(trimmed);
  let rawText: string;
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new UserError('备份文件无效或体积超出上限。');
    rawText = await readFile(target, 'utf8');
  } catch (e) {
    throw e instanceof UserError ? e : new UserError('无法读取备份文件，请检查路径是否正确。');
  }

  let env: BackupEnvelope;
  try {
    env = JSON.parse(rawText) as BackupEnvelope;
  } catch {
    throw new UserError('备份文件格式损坏。');
  }
  if (
    env?.format !== 'cgscaline-backup' ||
    env.version !== 1 ||
    env.kdf !== 'pbkdf2-sha512' ||
    !Number.isSafeInteger(env.iterations) ||
    env.iterations < 100_000 ||
    env.iterations > 1_000_000
  ) {
    throw new UserError('不支持的备份包版本或参数。');
  }

  let plaintext: Buffer;
  try {
    const salt = Buffer.from(env.salt, 'base64');
    const iv = Buffer.from(env.iv, 'base64');
    const tag = Buffer.from(env.tag, 'base64');
    const ciphertext = Buffer.from(env.ciphertext, 'base64');
    if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('iv/tag');
    const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, env.iterations, 32, 'sha512');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      plaintext = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } finally {
      key.fill(0);
    }
  } catch {
    throw new UserError('口令错误或备份包已被篡改，无法解密。');
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(plaintext.toString('utf8')) as BackupPayload;
  } catch {
    throw new UserError('备份内容解析失败。');
  }
  if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.libraries))
    throw new UserError('备份包结构不完整。');

  const stagedAccounts = [...store.state.accounts.map(a => structuredClone(a))];
  const accountIdMap = new Map<string, string>();
  let accountsAdded = 0;
  let accountsUpdated = 0;

  const conflicts: string[] = [];
  let sessionsSkipped = 0;
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const incoming of payload.accounts) {
    if (!incoming || typeof incoming.id !== 'string' || ids.has(incoming.id) ||
      typeof incoming.username !== 'string' || !/^[a-zA-Z0-9_@.-]{2,80}$/.test(incoming.username) ||
      !validDevice(incoming.device) || typeof incoming.school?.id !== 'string' ||
      typeof incoming.school.baseUrl !== 'string' || !incoming.school.baseUrl.endsWith('/'))
      throw new UserError('备份包中含有非法或重复账号档案。');
    const key = accountKey(incoming);
    if (keys.has(key)) throw new UserError('备份包中含有重复账号。');
    keys.add(key); ids.add(incoming.id);
    migrateIdentity(incoming);
    incoming.deviceUsage = deviceUsage(incoming);
    delete incoming.deviceRevision;
    delete incoming.compatibility;
    const session = incoming.session;
    if (payload.includeSessions !== true || !session || !['verified', 'saved'].includes(session.status) ||
      typeof session.id !== 'string' || !session.id || typeof session.token !== 'string' || !session.token ||
      typeof session.secret !== 'string' || !session.secret || session.xh !== incoming.username || session.identity !== identity(incoming)) {
      if (session) sessionsSkipped++;
      delete incoming.session;
      delete incoming.recordCache;
      delete incoming.information;
    } else {
      session.status = 'saved';
      for (const key of ['information', 'recordCache'] as const) {
        const cache = incoming[key];
        if (cache && (cache.identity !== session.identity || cache.sessionId !== session.id)) delete incoming[key];
      }
    }
  }
  const mergeAccounts = (entries: Bindings) => {
    for (const incoming of payload.accounts) {
      const existing = stagedAccounts.find(a => accountKey(a) === accountKey(incoming));
      const target = existing ?? structuredClone(incoming);
      if (existing) accountIdMap.set(incoming.id, existing.id);
      else if (!/^[a-f0-9-]{36}$/.test(target.id) || stagedAccounts.some(a => a.id === target.id)) target.id = randomUUID();
      try {
        if (existing && existing.school.id !== incoming.school.id) throw new BindingConflict();
        const same = sameDevice(target.device, incoming.device);
        const others = stagedAccounts.filter(a => a !== target);
        if (deviceConflicts({ ...target, device: incoming.device }, others).length) throw new BindingConflict();
        let entry;
        if (!existing) {
          const known = entries.get(target);
          if (known && !sameDevice(known.device, target.device)) throw new BindingConflict();
          target.deviceSource = 'portable';
          entry = entries.create(target);
        } else if (!same) {
          if (deviceUsage(existing) !== 'unused') throw new BindingConflict();
          entry = entries.replace(existing, incoming.device, 'portable', true);
          delete target.information; delete target.recordCache; delete target.compatibility;
        } else entry = entries.verify(target);
        if (incoming.deviceUsage === 'attempted') entry.usage = 'attempted';
        else if (entry.usage === 'unused' && incoming.deviceUsage !== 'unused') entry.usage = 'unknown';
        applyBinding(target, entry);
        const canRestore = incoming.session && incoming.session.identity === identity(target) &&
          (!existing?.session || existing.session.status === 'invalid');
        if (canRestore) {
          target.session = structuredClone(incoming.session);
          target.information = structuredClone(incoming.information);
          target.recordCache = structuredClone(incoming.recordCache);
        } else if (incoming.session && (incoming.session.identity !== identity(target) || incoming.session.id !== target.session?.id)) sessionsSkipped++;
        if (existing) { if (!same || canRestore) accountsUpdated++; }
        else { stagedAccounts.push(target); accountIdMap.set(incoming.id, target.id); accountsAdded++; }
      } catch (error) {
        if (!(error instanceof BindingConflict)) throw error;
        conflicts.push(incoming.id);
        if (incoming.session) sessionsSkipped++;
        accountIdMap.delete(incoming.id);
      }
    }
  };

  let librariesAdded = 0;
  const stagedLibraries = [...store.state.libraries.map(l => structuredClone(l))];
  const planned: Array<{ id: string; meta: Library; data: unknown }> = [];
  for (const item of payload.libraries) {
    const meta = item?.meta;
    if (!meta || typeof meta.id !== 'string' || !['private', 'public'].includes(meta.scope) || item.data === undefined) continue;
    const id = /^[a-f0-9-]{36}$/.test(meta.id) ? meta.id : randomUUID();
    if (stagedLibraries.some(l => l.id === id) || planned.some(l => l.id === id)) continue;
    if (meta.scope === 'private' && (!meta.ownerAccountId || !ids.has(meta.ownerAccountId))) continue;
    planned.push({ id, meta, data: item.data });
  }

  await commitBindings(store, registry, mergeAccounts, async () => {
    for (const { id, meta, data } of planned) {
      const owner = meta.ownerAccountId && accountIdMap.get(meta.ownerAccountId);
      if (meta.scope === 'private' && !owner) continue;
      await store.putLibrary(id, data);
      stagedLibraries.push({
        id, label: String(meta.label ?? '导入记录库').slice(0, 60), scope: meta.scope,
        ...(meta.scope === 'private' && owner ? { ownerAccountId: owner } : {}),
        ...(typeof meta.schoolBaseUrl === 'string' ? { schoolBaseUrl: meta.schoolBaseUrl } : {}),
        ...(typeof meta.schoolId === 'string' ? { schoolId: meta.schoolId } : {}),
        ...(typeof meta.schoolName === 'string' ? { schoolName: meta.schoolName } : {}),
        runCount: Number(meta.runCount) || 0, routeIds: Array.isArray(meta.routeIds) ? meta.routeIds.map(String) : [],
        importedAt: Number(meta.importedAt) || Date.now(),
      });
      librariesAdded++;
    }
    for (const acc of stagedAccounts) {
      if (acc.libraryId && !stagedLibraries.some(l => l.id === acc.libraryId && canUseLibrary(l, acc))) {
        const match = stagedLibraries.find(l => canUseLibrary(l, acc));
        acc.libraryId = match?.id;
      }
    }

    store.state.accounts = stagedAccounts;
    store.state.libraries = stagedLibraries;
    const s = store.state.settings;
    if (!s.schoolId && payload.settings?.schoolId) s.schoolId = String(payload.settings.schoolId);
    if (s.termTarget === undefined && typeof payload.settings?.termTarget === 'number' && payload.settings.termTarget > 0) {
      s.termTarget = payload.settings.termTarget;
    }
  });
  return { accountsAdded, accountsUpdated, librariesAdded, conflicts, sessionsSkipped };
}
