import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { deviceConflicts } from '../core/device-identity.js';
import { activeTask, identity, UserError, type Account, type Library, type State } from '../core/model.js';
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

  const isValidSchoolUrl = (u: unknown): u is string => {
    if (typeof u !== 'string' || !u.endsWith('/')) return false;
    try {
      const parsed = new URL(u);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  };

  for (const incoming of payload.accounts) {
    if (
      !incoming ||
      typeof incoming.id !== 'string' ||
      typeof incoming.username !== 'string' ||
      !/^[a-zA-Z0-9_@.-]{2,80}$/.test(incoming.username) ||
      !incoming.device ||
      !/^[a-f\d]{16}$/i.test(incoming.device.androidId) ||
      !isValidSchoolUrl(incoming.school?.baseUrl)
    ) {
      throw new UserError('备份包中含有非法账号档案，已中止导入。');
    }
    const existing = stagedAccounts.find(a => a.username === incoming.username && a.school.baseUrl === incoming.school.baseUrl);
    if (existing) {
      accountIdMap.set(incoming.id, existing.id);
      if ((!existing.session || existing.session.status === 'invalid') && incoming.session && incoming.session.xh === existing.username) {
        const candidate: Account = { ...existing, device: structuredClone(incoming.device), proxy: incoming.proxy ?? existing.proxy };
        if (deviceConflicts(candidate, stagedAccounts.filter(x => x.id !== existing.id)).length === 0) {
          existing.device = candidate.device;
          existing.proxy = candidate.proxy;
          existing.session = { ...structuredClone(incoming.session), identity: identity(existing), status: 'saved' };
          if (incoming.information) existing.information = { ...structuredClone(incoming.information), identity: identity(existing), sessionId: existing.session.id };
          if (incoming.recordCache) existing.recordCache = { ...structuredClone(incoming.recordCache), identity: identity(existing), sessionId: existing.session.id };
          accountsUpdated++;
        }
      }
      continue;
    }
    const fresh: Account = structuredClone(incoming);
    if (!/^[a-f0-9-]{36}$/.test(fresh.id) || stagedAccounts.some(a => a.id === fresh.id)) fresh.id = randomUUID();
    accountIdMap.set(incoming.id, fresh.id);
    fresh.device.androidId = fresh.device.androidId.toLowerCase();
    if (deviceConflicts(fresh, stagedAccounts).length > 0)
      throw new UserError(`备份中的账号 ${fresh.username} 与现有账号设备标识冲突，已中止导入。`);
    if (fresh.session) {
      if (fresh.session.xh !== fresh.username) delete fresh.session;
      else {
        fresh.session.identity = identity(fresh);
        fresh.session.status = 'saved';
      }
    }
    delete fresh.compatibility;
    stagedAccounts.push(fresh);
    accountsAdded++;
  }

  let librariesAdded = 0;
  const stagedLibraries = [...store.state.libraries.map(l => structuredClone(l))];
  for (const item of payload.libraries) {
    const meta = item?.meta;
    if (!meta || typeof meta.id !== 'string' || !['private', 'public'].includes(meta.scope) || item.data === undefined) continue;
    let libId = /^[a-f0-9-]{36}$/.test(meta.id) ? meta.id : randomUUID();
    const mappedOwner = meta.scope === 'private' && meta.ownerAccountId ? (accountIdMap.get(meta.ownerAccountId) ?? meta.ownerAccountId) : undefined;
    if (meta.scope === 'private' && (!mappedOwner || !stagedAccounts.some(a => a.id === mappedOwner))) continue;
    if (stagedLibraries.some(l => l.id === libId)) continue;
    const savedMeta: Library = {
      id: libId,
      label: String(meta.label ?? '导入记录库').slice(0, 60),
      scope: meta.scope,
      ...(mappedOwner ? { ownerAccountId: mappedOwner } : {}),
      runCount: Number(meta.runCount) || 0,
      routeIds: Array.isArray(meta.routeIds) ? meta.routeIds.map(String) : [],
      importedAt: Number(meta.importedAt) || Date.now(),
    };
    await store.putLibrary(libId, item.data);
    stagedLibraries.push(savedMeta);
    librariesAdded++;
  }

  for (const acc of stagedAccounts) {
    if (acc.libraryId && !stagedLibraries.some(l => l.id === acc.libraryId)) {
      const match = stagedLibraries.find(l => l.scope === acc.sourceMode && (l.scope === 'public' || l.ownerAccountId === acc.id));
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
  await store.save();
  return { accountsAdded, accountsUpdated, librariesAdded };
}
