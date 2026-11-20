import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync, closeSync, unlinkSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { emptyState, UserError, type State, type Prepared, type Task } from '../core/model.js';
import { payloadName, freezePrepared, preparedSummary, encodePayload, compressPayload, decodePayload, type TaskPayloadRef } from './task-payload.js';

type PayloadEntry = { ref: TaskPayloadRef; prepared: Prepared; summary: Prepared; bytes?: Buffer; durable: boolean; loaded: boolean };
type DiskTask = Task & { preparedRef: TaskPayloadRef };

export interface Vault { protect(data: Buffer): Promise<Buffer>; unprotect(data: Buffer): Promise<Buffer> }

/** 只把固定脚本放进进程参数，数据通过 stdin；复用短驻留 PowerShell 协进程消除每次冷启动延迟。 */
export class WindowsVault implements Vault {
  private static queue: Promise<unknown> = Promise.resolve();
  private static worker?: { child: ReturnType<typeof spawn>; idle?: ReturnType<typeof setTimeout> };
  private crypt(data: Buffer, method: 'Protect' | 'Unprotect'): Promise<Buffer> {
    if (process.platform !== 'win32') throw new UserError('真实档案当前需要 Windows DPAPI；其他平台请使用 --demo。');
    const job = WindowsVault.queue.catch(() => {}).then(() => new Promise<Buffer>((resolve, reject) => {
      let w = WindowsVault.worker;
      if (!w || w.child.killed || w.child.exitCode !== null) {
        const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ` +
          `$e=[Text.Encoding]::UTF8.GetBytes('CGSPORT-terminal-v1'); ` +
          `while(($line=[Console]::In.ReadLine()) -ne $null){ ` +
          `try{ $p=$line.Split(':',2); $v=[Convert]::FromBase64String($p[1]); ` +
          `$r=if($p[0] -eq 'Protect'){[Security.Cryptography.ProtectedData]::Protect($v,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{[Security.Cryptography.ProtectedData]::Unprotect($v,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; ` +
          `[Console]::Out.WriteLine('OK:'+[Convert]::ToBase64String($r)); [Console]::Out.Flush(); }catch{ [Console]::Out.WriteLine('ERR'); [Console]::Out.Flush(); } }`;
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr?.resume();
        child.stdin?.on('error', () => {});
        child.unref();
        w = WindowsVault.worker = { child };
      }
      if (w.idle) clearTimeout(w.idle);
      let buf = '';
      const cleanup = () => {
        clearTimeout(timer);
        w!.child.stdout?.off('data', onData);
        w!.child.off('error', onError);
        w!.child.off('close', onClose);
        w!.idle = setTimeout(() => { w!.child.kill(); if (WindowsVault.worker === w) WindowsVault.worker = undefined; }, 1500);
        w!.idle.unref();
      };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('ascii');
        if (buf.length > 180_000_000) { w!.child.kill(); cleanup(); reject(new UserError('无法解密档案，请使用原来的 Windows 账号。')); return; }
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          cleanup();
          if (line.startsWith('OK:')) resolve(Buffer.from(line.slice(3), 'base64'));
          else reject(new UserError('无法解密档案，请使用原来的 Windows 账号。'));
        }
      };
      const onError = () => { cleanup(); reject(new UserError('Windows 加密服务无法启动。')); };
      const onClose = () => { cleanup(); reject(new UserError('无法解密档案，请使用原来的 Windows 账号。')); };
      const timer = setTimeout(() => { w!.child.kill(); cleanup(); reject(new UserError('Windows 加密服务超时。')); }, 30_000);
      w.child.stdout?.on('data', onData);
      w.child.once('error', onError);
      w.child.once('close', onClose);
      w.child.stdin?.write(`${method}:${data.toString('base64')}\n`);
    }));
    WindowsVault.queue = job;
    return job;
  }
  protect(data: Buffer) { return this.crypt(data, 'Protect'); }
  unprotect(data: Buffer) { return this.crypt(data, 'Unprotect'); }
}

export class Store {
  state: State = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private locked = false;
  private blobs = new Map<string, unknown>();
  private payloads = new Map<string, PayloadEntry>();
  private obsoletePayloads = new Set<string>();
  private legacyBackup?: Buffer;
  private cleanupOrphans = true;
  constructor(readonly root: string | null, private vault: Vault = new WindowsVault()) {}
  async open(): Promise<void> {
    if (!this.root) return;
    mkdirSync(this.root, { recursive: true });
    try {
      const fd = openSync(join(this.root, 'instance.lock'), 'wx');
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() })); } finally { closeSync(fd); }
      this.locked = true;
    } catch { throw new UserError('档案已由另一个进程打开；异常退出后可用 --unlock 检查并释放旧锁。'); }
    this.payloads.clear(); this.obsoletePayloads.clear(); this.legacyBackup = undefined; this.cleanupOrphans = true;
    try {
      const path = join(this.root, 'state.dpapi');
      if (existsSync(path)) {
        const raw = await readFile(path);
        const parsed = JSON.parse((await this.vault.unprotect(raw)).toString('utf8'));
        if (![1, 2].includes(parsed.schemaVersion) || !Array.isArray(parsed.accounts) || !Array.isArray(parsed.tasks) ||
          !Array.isArray(parsed.libraries) || !parsed.settings) throw new Error('schema');
        if (parsed.schemaVersion === 1) this.legacyBackup = raw;
        else for (const task of parsed.tasks as DiskTask[]) {
          payloadName(task.id, task.preparedRef);
          const summary = freezePrepared(task.prepared), entry: PayloadEntry = { ref: task.preparedRef, prepared: summary, summary, durable: true, loaded: false };
          this.payloads.set(task.id, entry); delete (task as Partial<DiskTask>).preparedRef;
          if (!['done', 'abandoned'].includes(task.phase)) {
            try { task.prepared = entry.prepared = await this.readPayload(task, entry.ref); entry.loaded = true; }
            catch { task.phase = 'review'; task.note = '运动数据文件无法读取，请恢复备份。'; delete task.resumePhase; }
          }
        }
        this.state = { ...parsed, schemaVersion: 1 };
      }
    } catch { this.close(); throw new UserError('无法读取加密档案。'); }
  }
  save(): Promise<void> {
    if (!this.root) return Promise.resolve();
    // Prepared snapshots are immutable. Only a new object creates a new payload revision.
    const entries: PayloadEntry[] = [];
    const tasks = this.state.tasks.map(task => {
      let entry = this.payloads.get(task.id);
      if (!entry || entry.prepared !== task.prepared) {
        if (entry?.durable) this.obsoletePayloads.add(payloadName(task.id, entry.ref));
        freezePrepared(task.prepared); const encoded = encodePayload(task.id, task.accountId, task.prepared);
        payloadName(task.id, encoded.ref);
        entry = { ...encoded, prepared: task.prepared, summary: preparedSummary(task.prepared), durable: false, loaded: true };
        this.payloads.set(task.id, entry);
      }
      entries.push(entry); return { ...task, prepared: entry.summary, preparedRef: entry.ref };
    });
    const snapshot = Buffer.from(JSON.stringify({ ...this.state, schemaVersion: 2, tasks }));
    const backup = this.legacyBackup;
    const work = this.queue.then(async () => {
      if (backup) {
        const hash = createHash('sha256').update(backup).digest('hex').slice(0, 24);
        await this.atomic(`state-v1-${hash}.dpapi`, backup);
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        if (!entry.durable) {
          await this.atomic(payloadName(tasks[i]!.id, entry.ref), await this.vault.protect(await compressPayload(entry.bytes!)));
          entry.durable = true; entry.bytes = undefined;
        }
      }
      await this.atomic('state.dpapi', await this.vault.protect(snapshot));
      if (this.legacyBackup === backup) this.legacyBackup = undefined;
      for (const task of this.state.tasks) {
        const entry = this.payloads.get(task.id);
        if (entry?.durable && entry.loaded && ['done', 'abandoned'].includes(task.phase) && task.prepared === entry.prepared) {
          task.prepared = entry.prepared = entry.summary; entry.loaded = false;
        }
      }
      const kept = new Set(tasks.map(t => t.id));
      const currentIds = new Set(this.state.tasks.map(t => t.id));
      for (const [id, entry] of this.payloads) if (!kept.has(id) && !currentIds.has(id)) {
        // State no longer references the payload before its encrypted file is removed.
        if (entry.durable) await unlink(join(this.root!, payloadName(id, entry.ref))).catch(e => { if (e.code !== 'ENOENT') throw e; });
        if (this.payloads.get(id) === entry) this.payloads.delete(id);
      }
      const liveFiles = new Set(tasks.map(t => payloadName(t.id, t.preparedRef)));
      for (const name of this.obsoletePayloads) if (!liveFiles.has(name)) {
        await unlink(join(this.root!, name)).catch(e => { if (e.code !== 'ENOENT') throw e; }); this.obsoletePayloads.delete(name);
      }
      if (this.cleanupOrphans) {
        // A crash can leave an encrypted blob whose state index was never committed.
        // Scan once per open, only after a successful index commit, within this store.
        for (const name of await readdir(this.root!)) if (/^task-[a-f0-9-]{36}-[a-f0-9]{64}\.dpapi$/.test(name) && !liveFiles.has(name))
          await unlink(join(this.root!, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        this.cleanupOrphans = false;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
  private async atomic(name: string, bytes: Buffer) {
    if (!this.root) return;
    const target = join(this.root, name), temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600, flush: true }); await rename(temp, target); }
    catch (e) { await unlink(temp).catch(() => {}); throw e; }
  }
  private async readPayload(task: Task, ref: TaskPayloadRef) {
    const encrypted = await readFile(join(this.root!, payloadName(task.id, ref)));
    if (encrypted.length > 80_000_000) throw new Error('Task payload too large');
    return decodePayload(await this.vault.unprotect(encrypted), task.id, task.accountId, ref);
  }
  /** Explicit inspection/export; finished payloads stay out of the resident state. */
  async getTaskPrepared(id: string): Promise<Prepared> {
    const task = this.state.tasks.find(t => t.id === id); if (!task) throw new UserError('任务不存在。');
    const entry = this.payloads.get(id);
    if (!entry || entry.loaded) return task.prepared;
    try { return await this.readPayload(task, entry.ref); } catch { throw new UserError('运动数据文件无法读取，请恢复备份。'); }
  }
  async putLibrary(id: string, value: unknown) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError('记录库 ID 非法。');
    if (!this.root) { this.blobs.set(id, structuredClone(value)); return; }
    await this.atomic(`library-${id}.dpapi`, await this.vault.protect(Buffer.from(JSON.stringify(value))));
  }
  async getLibrary<T>(id: string): Promise<T> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError('记录库 ID 非法。');
    if (!this.root) return structuredClone(this.blobs.get(id)) as T;
    try { return JSON.parse((await this.vault.unprotect(await readFile(join(this.root, `library-${id}.dpapi`)))).toString('utf8')); }
    catch { throw new UserError('记录库无法解密或文件损坏。'); }
  }
  async deleteLibrary(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserError('记录库 ID 非法。');
    if (!this.root) { this.blobs.delete(id); return; }
    try { await unlink(join(this.root, `library-${id}.dpapi`)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  async flush() { await this.queue; }
  close() {
    if (this.root && this.locked) { unlinkSync(join(this.root, 'instance.lock')); this.locked = false; }
  }
}

export function unlockStale(root: string) {
  const path = join(root, 'instance.lock');
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  let owner: { pid: number };
  try { owner = JSON.parse(raw); } catch { throw new UserError('锁文件损坏，请先确认没有 CGSCALINE / 旧版进程再人工处理。'); }
  try { process.kill(owner.pid, 0); throw new UserError('持锁进程仍在运行，不能释放。'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
  if (readFileSync(path, 'utf8') === raw) unlinkSync(path);
}
