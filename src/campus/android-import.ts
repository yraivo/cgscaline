import { spawn, execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
import type { Dataset, GcjCoord, RouteConfig, RunRecord } from '../track/types.js';
import { UserError } from '../core/model.js';

function loadNodeSqlite() {
  const builtin = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:sqlite');
  if (builtin) return builtin as {
    DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
      prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>>; get(...params: unknown[]): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  throw new UserError('当前 Node.js 版本不支持内置 node:sqlite，请使用 Node.js 22.19+ 或 24。');
}

// CGSport Android 客户端 LitePal 固定数据库密钥（WCDB / SQLCipher 3, pageSize=1024, reserve=48）
export const DEFAULT_WCDB_KEY = 'd8c0521f8bd58cb5eae44f9c4bf647c5';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const ANDROID_BACKUP_MAGIC = Buffer.from('ANDROID BACKUP\n', 'ascii');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PAGE_SIZE = 1024;
const RESERVE_SIZE = 48;

export function stripInputQuotes(raw: string): string {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

export function parseBoundaryString(raw: unknown): GcjCoord[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const pts: GcjCoord[] = [];
  for (const seg of raw.split(';')) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 2) continue;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      pts.push([lat, lng]);
    }
  }
  return pts.length >= 3 ? pts : undefined;
}

export function parseSensorText(raw: string): number[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const body = trimmed.replace(/^\[+/, '').replace(/\]+$/, '');
  const nums: number[] = [];
  for (const part of body.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const v = Number(s);
    if (!Number.isFinite(v)) return undefined;
    nums.push(v);
    if (nums.length >= 100_000) return undefined;
  }
  return nums.length >= 10 ? nums : undefined;
}

export function decryptWcdbBuffer(data: Buffer, password = DEFAULT_WCDB_KEY): Buffer {
  if (data.length >= 16 && data.subarray(0, 16).equals(SQLITE_MAGIC)) {
    return data;
  }
  if (data.length < PAGE_SIZE || data.length % PAGE_SIZE !== 0) {
    throw new UserError('数据库文件长度异常，不是有效的创高体育数据库。');
  }
  const salt = data.subarray(0, 16);
  const key = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, 64_000, 32, 'sha1');
  const out = Buffer.allocUnsafe(data.length);
  const pages = data.length / PAGE_SIZE;

  for (let p = 0; p < pages; p++) {
    const pageOffset = p * PAGE_SIZE;
    const page = data.subarray(pageOffset, pageOffset + PAGE_SIZE);
    const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + 16);
    const cipherSlice = p === 0 ? page.subarray(16, PAGE_SIZE - RESERVE_SIZE) : page.subarray(0, PAGE_SIZE - RESERVE_SIZE);
    const dec = createDecipheriv('aes-256-cbc', key, iv);
    dec.setAutoPadding(false);
    const plain = Buffer.concat([dec.update(cipherSlice), dec.final()]);
    if (p === 0) {
      SQLITE_MAGIC.copy(out, 0);
      plain.copy(out, 16);
    } else {
      plain.copy(out, pageOffset);
    }
    out.fill(0, pageOffset + PAGE_SIZE - RESERVE_SIZE, pageOffset + PAGE_SIZE);
  }
  return out;
}

function readAsciiLine(buf: Buffer, pos: number): [string, number] {
  const nl = buf.indexOf(0x0a, pos);
  if (nl < 0) throw new UserError('安卓备份包文件头不完整。');
  return [buf.subarray(pos, nl).toString('ascii').trim(), nl + 1];
}

export function unpackAndroidBackupToTar(data: Buffer): Buffer {
  const magicIdx = data.indexOf(ANDROID_BACKUP_MAGIC);
  if (magicIdx < 0) throw new UserError('未识别的安卓备份包格式。');
  let pos = magicIdx + ANDROID_BACKUP_MAGIC.length;
  const [_version, p1] = readAsciiLine(data, pos); pos = p1;
  const [compressed, p2] = readAsciiLine(data, pos); pos = p2;
  const [encryption, p3] = readAsciiLine(data, pos); pos = p3;
  if (encryption !== 'none') {
    throw new UserError('该备份包设置了加密密码；请使用未设密码的本地备份。');
  }
  const payload = data.subarray(pos);
  if (!payload.length) {
    throw new UserError('备份包内容为空（手机可能未确认备份或系统限制了 ADB 备份）。');
  }
  if (compressed === '1') {
    try {
      return inflateSync(payload, { maxOutputLength: 512 * 1024 * 1024 });
    } catch {
      throw new UserError('解压安卓备份包失败，文件可能已损坏。');
    }
  }
  if (compressed === '0') return payload;
  throw new UserError('不支持的安卓备份压缩标记。');
}

function parseTarString(buf: Buffer): string {
  const zero = buf.indexOf(0);
  return (zero >= 0 ? buf.subarray(0, zero) : buf).toString('utf8');
}

function parseTarOctal(buf: Buffer): number {
  const s = parseTarString(buf).trim();
  return s ? parseInt(s, 8) : 0;
}

export interface ExtractedAndroidSession {
  token: string;
  secret: string;
  loginOutTime: string;
  xh?: string;
  name?: string;
  gender?: string;
}

function parseSharedPrefsStringMap(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<string\s+name="([^"]+)">([^<]*)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

function buildExtractedSession(headerXml?: string, userXml?: string): ExtractedAndroidSession | undefined {
  if (!headerXml) return undefined;
  const h = parseSharedPrefsStringMap(headerXml);
  if (!h.TOKEN || !h.SECRET || h.SECRET.length < 16) return undefined;
  const u = userXml ? parseSharedPrefsStringMap(userXml) : {};
  return {
    token: h.TOKEN,
    secret: h.SECRET,
    loginOutTime: h.LOGIN_OUT_TIME || String(Date.now() + 30 * 86_400_000),
    ...(u.USERXH ? { xh: u.USERXH } : {}),
    ...(u.USERNAME ? { name: u.USERNAME } : {}),
    ...(u.USER_SEX ? { gender: u.USER_SEX } : {}),
  };
}

export function extractSportFilesFromTar(tar: Buffer): {
  db?: Buffer;
  sensors: Map<string, number[]>;
  session?: ExtractedAndroidSession;
} {
  let offset = 0;
  let nextLongName = '';
  let paxPath = '';
  let db: Buffer | undefined;
  let headerXml: string | undefined;
  let userXml: string | undefined;
  const sensors = new Map<string, number[]>();

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) continue;

    const size = parseTarOctal(header.subarray(124, 136));
    if (!Number.isFinite(size) || size < 0 || offset + size > tar.length) break;
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const name = parseTarString(header.subarray(0, 100));
    const prefix = parseTarString(header.subarray(345, 500));
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === 'L') {
      nextLongName = parseTarString(data);
      continue;
    }
    if (typeFlag === 'x') {
      const text = data.toString('utf8');
      for (const line of text.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp > 0) {
          const kv = line.slice(sp + 1);
          if (kv.startsWith('path=')) paxPath = kv.slice(5);
        }
      }
      continue;
    }

    const fullPath = (paxPath || nextLongName || (prefix ? `${prefix}/${name}` : name)).replace(/\\/g, '/');
    nextLongName = '';
    paxPath = '';

    if (/(?:^|\/)ygty_mysport\.db$/i.test(fullPath)) {
      db = Buffer.from(data);
    } else if (/(?:^|\/)sp\/HEADER\.xml$/i.test(fullPath) && size > 20 && size < 65_536) {
      headerXml = data.toString('utf8');
    } else if (/(?:^|\/)sp\/USERINFO\.xml$/i.test(fullPath) && size > 20 && size < 65_536) {
      userXml = data.toString('utf8');
    } else {
      const m = /(?:^|\/)sensor(?:_log)?\/([a-zA-Z0-9_-]{8,80})\.txt$/i.exec(fullPath);
      if (m && size > 10 && size < 4_000_000) {
        const parsed = parseSensorText(data.toString('utf8'));
        if (parsed) sensors.set(m[1]!, parsed);
      }
    }
  }
  const session = buildExtractedSession(headerXml, userXml);
  return { db, sensors, ...(session ? { session } : {}) };
}

export function extractSportFilesFromZip(zip: Buffer): {
  db?: Buffer;
  sensors: Map<string, number[]>;
  session?: ExtractedAndroidSession;
} {
  // Locate End of Central Directory (EOCD: 0x06054b50)
  const minPos = Math.max(0, zip.length - 65_558);
  let eocd = -1;
  for (let i = zip.length - 22; i >= minPos; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UserError('ZIP 压缩包结构无效或已损坏。');

  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > zip.length) throw new UserError('ZIP 目录索引越界。');

  let pos = cdOffset;
  const cdEnd = cdOffset + cdSize;
  let db: Buffer | undefined;
  let session: ExtractedAndroidSession | undefined;
  let headerXml: string | undefined;
  let userXml: string | undefined;
  const sensors = new Map<string, number[]>();

  const readEntry = (compMethod: number, compSize: number, uncompSize: number, localOffset: number): Buffer => {
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new UserError('ZIP 文件条目头损坏。');
    }
    const fnLen = zip.readUInt16LE(localOffset + 26);
    const extraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + fnLen + extraLen;
    if (dataStart + compSize > zip.length) throw new UserError('ZIP 条目数据不完整。');
    const slice = zip.subarray(dataStart, dataStart + compSize);
    if (compMethod === 0) return slice;
    if (compMethod === 8) return inflateRawSync(slice, { maxOutputLength: Math.max(uncompSize + 1024, 512 * 1024 * 1024) });
    throw new UserError(`不支持的 ZIP 压缩算法（method=${compMethod}）。`);
  };

  while (pos + 46 <= cdEnd) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = zip.readUInt16LE(pos + 10);
    const compSize = zip.readUInt32LE(pos + 20);
    const uncompSize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const entryName = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    pos += 46 + nameLen + extraLen + commentLen;

    if (/(?:^|\/)ygty_mysport\.db$/i.test(entryName)) {
      db = readEntry(compMethod, compSize, uncompSize, localOffset);
    } else if (/(?:^|\/)sp\/HEADER\.xml$/i.test(entryName) && uncompSize > 20 && uncompSize < 65_536) {
      headerXml = readEntry(compMethod, compSize, uncompSize, localOffset).toString('utf8');
    } else if (/(?:^|\/)sp\/USERINFO\.xml$/i.test(entryName) && uncompSize > 20 && uncompSize < 65_536) {
      userXml = readEntry(compMethod, compSize, uncompSize, localOffset).toString('utf8');
    } else if (/\.(?:bak|ab|tar)$/i.test(entryName) && uncompSize > 512 && uncompSize < 512 * 1024 * 1024) {
      const inner = readEntry(compMethod, compSize, uncompSize, localOffset);
      const tar = inner.indexOf(ANDROID_BACKUP_MAGIC) >= 0 ? unpackAndroidBackupToTar(inner) : inner;
      const res = extractSportFilesFromTar(tar);
      if (res.db) db = res.db;
      if (res.session) session = res.session;
      for (const [k, v] of res.sensors) sensors.set(k, v);
    } else {
      const m = /(?:^|\/)sensor(?:_log)?\/([a-zA-Z0-9_-]{8,80})\.txt$/i.exec(entryName);
      if (m && uncompSize > 10 && uncompSize < 4_000_000) {
        const parsed = parseSensorText(readEntry(compMethod, compSize, uncompSize, localOffset).toString('utf8'));
        if (parsed) sensors.set(m[1]!, parsed);
      }
    }
  }
  session ??= buildExtractedSession(headerXml, userXml);
  return { db, sensors, ...(session ? { session } : {}) };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function scalarOrNull(v: unknown): string | number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return v;
  return null;
}

function durationSecFromText(v: unknown): number | null {
  if (!v) return null;
  const parts = String(v).trim().split(':').map(Number);
  if (parts.length !== 3 || parts.some(x => !Number.isFinite(x) || x < 0)) return null;
  return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

export async function extractDatasetFromSqliteBuffer(
  rawDb: Buffer,
  sensorBySportId: Map<string, number[]> = new Map(),
): Promise<{ dataset: Dataset; sensors: Record<string, number[]> }> {
  const plainDb = decryptWcdbBuffer(rawDb);
  const tmpFile = join(tmpdir(), `cgsport-db-${randomUUID()}.sqlite`);
  await writeFile(tmpFile, plainDb, { mode: 0o600 });

  try {
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(tmpFile, { readOnly: true });
    try {
      const check = db.prepare('PRAGMA integrity_check;').get();
      const checkVal = check ? Object.values(check)[0] : undefined;
      if (checkVal !== 'ok') {
        throw new UserError('数据库解密校验未通过，请确认文件来自创高体育。');
      }

      const strictRows = db.prepare(`
        SELECT id, sportid, routeid, routename, startdate, enddate,
               dllc, dltime, totalstep, avgspeed, avgpace, stepminute,
               status, activitystatus, result, gyrouploadstatus,
               checkstatus, checkresult, isvalidreason
        FROM sportbean
        WHERE status = 1 AND gyrouploadstatus = 1 AND result = 1
          AND checkstatus = '1' AND COALESCE(isvalidreason, '') = ''
        ORDER BY startdatelong, id
      `).all();

      const runRows = strictRows.length
        ? strictRows
        : db.prepare(`
            SELECT id, sportid, routeid, routename, startdate, enddate,
                   dllc, dltime, totalstep, avgspeed, avgpace, stepminute,
                   status, activitystatus, result, gyrouploadstatus,
                   checkstatus, checkresult, isvalidreason
            FROM sportbean
            WHERE status = 1 AND result = 1
              AND checkstatus = '1' AND COALESCE(isvalidreason, '') = ''
            ORDER BY startdatelong, id
          `).all();

      if (!runRows.length) {
        throw new UserError('数据库中未找到已通过审核的有效跑步记录；请先在手机 App 内拥有至少 1 条有效运动记录。');
      }

      const ptStmt = db.prepare(`
        SELECT id, a, o, ac, d, da, s, st, sta, t, v
        FROM sportlatlngbean
        WHERE sportbean_id = ?
        ORDER BY COALESCE(t, id), id
      `);
      const paceStmt = db.prepare(`
        SELECT km, kmtotallength, kmdlsj, t
        FROM cpacestr
        WHERE sportid = ?
        ORDER BY id
      `);
      const minStmt = db.prepare(`
        SELECT min, v
        FROM cminutespeedstr
        WHERE sportid = ?
        ORDER BY id
      `);

      const runs: RunRecord[] = [];
      const routeIds = new Set<string>();
      const sensors: Record<string, number[]> = {};

      for (const r of runRows) {
        const id = Number(r.id);
        const sportId = String(r.sportid ?? '');
        const routeId = r.routeid !== null && r.routeid !== undefined ? String(r.routeid) : '';
        if (!Number.isFinite(id) || !sportId || !routeId) continue;
        routeIds.add(routeId);

        const points = ptStmt.all(sportId).map(pt => {
          const lat = numOrNull(pt.a);
          const lng = numOrNull(pt.o);
          const ts = intOrNull(pt.t);
          const vf = intOrNull(pt.v);
          const coordOk = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
          return {
            id: Number(pt.id ?? 0),
            latGcj02: lat,
            lngGcj02: lng,
            timestampMs: ts,
            accuracyM: numOrNull(pt.ac),
            distanceDeltaM: numOrNull(pt.d),
            distanceTotalM: numOrNull(pt.da),
            speedKmh: numOrNull(pt.s),
            stepDelta: intOrNull(pt.st),
            stepTotal: intOrNull(pt.sta),
            validFlag: vf,
            usable: Boolean(ts && ts > 0 && vf === 1 && coordOk),
          };
        });

        const paceSplits = paceStmt.all(sportId).map(row => ({
          km: intOrNull(row.km) ?? undefined,
          totalLengthM: numOrNull(row.kmtotallength) ?? undefined,
          durationMs: intOrNull(row.kmdlsj) ?? undefined,
          pace: row.t ? String(row.t) : undefined,
        }));

        const minuteSpeeds = minStmt.all(sportId).map(row => ({
          minute: intOrNull(row.min) ?? undefined,
          speed: numOrNull(row.v) ?? undefined,
        }));

        runs.push({
          id,
          sportId,
          routeId,
          routeName: r.routename ? String(r.routename) : null,
          startDate: r.startdate ? String(r.startdate) : null,
          endDate: r.enddate ? String(r.enddate) : null,
          distanceKm: numOrNull(r.dllc),
          durationSec: durationSecFromText(r.dltime),
          totalSteps: intOrNull(r.totalstep),
          avgSpeedKmh: numOrNull(r.avgspeed),
          avgPace: r.avgpace ? String(r.avgpace) : null,
          stepMinute: numOrNull(r.stepminute),
          statusEvidence: {
            status: scalarOrNull(r.status),
            activityStatus: scalarOrNull(r.activitystatus),
            result: scalarOrNull(r.result),
            gyroUploadStatus: scalarOrNull(r.gyrouploadstatus),
            checkStatus: scalarOrNull(r.checkstatus),
            checkResult: scalarOrNull(r.checkresult),
            isValidReason: scalarOrNull(r.isvalidreason),
          },
          points,
          paceSplits,
          minuteSpeeds,
        });

        const matchedSensor = sensorBySportId.get(sportId);
        if (matchedSensor) sensors[String(id)] = matchedSensor;
      }

      const routes: RouteConfig[] = [];
      try {
        const routeStmt = db.prepare(`
          SELECT routeid, routename, polyline
          FROM customroutemodel
          WHERE CAST(routeid AS TEXT) = ?
          ORDER BY id DESC LIMIT 1
        `);
        const attrStmt = db.prepare(`
          SELECT routeid, sportname, latlng, minspeed, maxspeed,
                 minvtime, maxvtime, vdistance, vcount, mindistanceofrunway, tips
          FROM exerciseattribute
          WHERE CAST(routeid AS TEXT) = ?
          ORDER BY id DESC LIMIT 1
        `);
        for (const rid of [...routeIds].sort()) {
          let routeRow: Record<string, unknown> | undefined;
          let attrRow: Record<string, unknown> | undefined;
          try { routeRow = routeStmt.get(rid); } catch { /* optional table */ }
          try { attrRow = attrStmt.get(rid); } catch { /* optional table */ }
          routes.push({
            routeId: rid,
            name: (attrRow?.sportname ? String(attrRow.sportname) : undefined) ?? (routeRow?.routename ? String(routeRow.routename) : null),
            boundaryGcj02: parseBoundaryString(attrRow?.latlng) ?? [],
            polylineGcj02: parseBoundaryString(routeRow?.polyline) ?? [],
            minSpeedKmh: numOrNull(attrRow?.minspeed),
            maxSpeedKmh: numOrNull(attrRow?.maxspeed),
            minDurationSec: durationSecFromText(attrRow?.minvtime),
            maxDurationSec: durationSecFromText(attrRow?.maxvtime),
            targetDistanceKm: numOrNull(attrRow?.vdistance),
            checkpointCount: intOrNull(attrRow?.vcount),
            minDistanceOfRunway: numOrNull(attrRow?.mindistanceofrunway),
            tips: attrRow?.tips ? String(attrRow.tips) : null,
            unresolvedRules: [],
          });
        }
      } catch {
        // Ignore optional route metadata table variations
      }

      return {
        dataset: {
          schemaVersion: 1,
          coordinateSystem: 'GCJ-02',
          generatedAt: new Date().toISOString(),
          source: {
            database: 'ygty_mysport.db',
            databaseSha256: '',
            selectionSql: 'valid',
            runCount: runs.length,
          },
          runs,
          routes,
        },
        sensors,
      };
    } finally {
      db.close();
    }
  } finally {
    await unlink(tmpFile).catch(() => {});
  }
}

async function scanNearbySensorDir(baseDir: string, out: Map<string, number[]>) {
  for (const sub of ['sensor', 'sensor_log', 'sensors', join('sensor', 'sensor'), join('files', 'sensor')]) {
    const dir = resolve(baseDir, sub);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
        const stem = entry.name.slice(0, -4);
        if (out.has(stem) || !/^[a-zA-Z0-9_-]{8,80}$/.test(stem)) continue;
        const st = await stat(join(dir, entry.name));
        if (st.size > 10 && st.size < 4_000_000) {
          const parsed = parseSensorText(await readFile(join(dir, entry.name), 'utf8'));
          if (parsed) out.set(stem, parsed);
        }
      }
    } catch {
      // Directory doesn't exist; ignore
    }
  }
}

async function findSportFileInDir(dir: string, depth = 0): Promise<string | undefined> {
  if (depth > 5) return undefined;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && /^ygty_mysport(?:_decrypted)?\.db$/i.test(e.name)) return join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isFile() && (/cgsport.*\.(?:bak|ab|zip|tar)$/i.test(e.name) || /^success_dataset\.json$/i.test(e.name))) {
      return join(dir, e.name);
    }
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      const found = await findSportFileInDir(join(dir, e.name), depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export async function loadAnySportSource(rawPath: string): Promise<{
  dataset: Dataset;
  sensors: Record<string, number[]>;
  session?: ExtractedAndroidSession;
}> {
  const cleanedPath = stripInputQuotes(rawPath);
  if (!cleanedPath) throw new UserError('文件路径不能为空。');
  let targetPath = resolve(cleanedPath);
  let st;
  try {
    st = await stat(targetPath);
  } catch {
    throw new UserError(`找不到文件或目录：${cleanedPath}`);
  }
  if (st.isDirectory()) {
    const inner = await findSportFileInDir(targetPath);
    if (!inner) throw new UserError('所选文件夹内未找到 ygty_mysport.db、手机备份包 (.bak/.zip) 或 JSON 数据集。');
    targetPath = inner;
    st = await stat(targetPath);
  }
  if (st.size > 350_000_000) throw new UserError('文件超过 350MB 上限。');

  const buf = await readFile(targetPath);
  const ext = extname(targetPath).toLowerCase();
  const nearbySensors = new Map<string, number[]>();
  await scanNearbySensorDir(dirname(targetPath), nearbySensors);
  await scanNearbySensorDir(dirname(dirname(targetPath)), nearbySensors);

  // 1. ZIP archive (e.g., MIUI backup zip)
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    const { db, sensors, session } = extractSportFilesFromZip(buf);
    if (!db) throw new UserError('ZIP 压缩包内未找到创高体育数据库 (ygty_mysport.db)。');
    for (const [k, v] of sensors) nearbySensors.set(k, v);
    const out = await extractDatasetFromSqliteBuffer(db, nearbySensors);
    return { ...out, ...(session ? { session } : {}) };
  }

  // 2. Android/MIUI Backup (.bak / .ab)
  if (buf.subarray(0, Math.min(buf.length, 4096)).indexOf(ANDROID_BACKUP_MAGIC) >= 0) {
    const tar = unpackAndroidBackupToTar(buf);
    const { db, sensors, session } = extractSportFilesFromTar(tar);
    if (!db) throw new UserError('备份包内未找到创高体育数据库 (ygty_mysport.db)。');
    for (const [k, v] of sensors) nearbySensors.set(k, v);
    const out = await extractDatasetFromSqliteBuffer(db, nearbySensors);
    return { ...out, ...(session ? { session } : {}) };
  }

  // 3. Plain TAR archive
  if (ext === '.tar' || (buf.length > 512 && buf.subarray(257, 262).toString('ascii') === 'ustar')) {
    const { db, sensors, session } = extractSportFilesFromTar(buf);
    if (!db) throw new UserError('TAR 归档内未找到创高体育数据库 (ygty_mysport.db)。');
    for (const [k, v] of sensors) nearbySensors.set(k, v);
    const out = await extractDatasetFromSqliteBuffer(db, nearbySensors);
    return { ...out, ...(session ? { session } : {}) };
  }

  // 4. JSON dataset (starts with '{')
  const firstNonWs = buf.subarray(0, Math.min(buf.length, 64)).toString('utf8').trimStart()[0];
  if (ext === '.json' || firstNonWs === '{') {
    let parsed: Dataset;
    try {
      parsed = JSON.parse(buf.toString('utf8')) as Dataset;
    } catch {
      throw new UserError('JSON 数据文件格式错误。');
    }
    if (
      !Array.isArray(parsed.runs) ||
      !parsed.runs.length ||
      parsed.coordinateSystem !== 'GCJ-02' ||
      parsed.runs.some(r => !Number.isFinite(r.id) || !Array.isArray(r.points) || typeof r.routeId !== 'string')
    ) {
      throw new UserError('JSON 文件缺少有效的 GCJ-02 点级轨迹数据。');
    }
    const sensors: Record<string, number[]> = {};
    for (const run of parsed.runs) {
      if (run.sportId && nearbySensors.has(run.sportId)) {
        sensors[String(run.id)] = nearbySensors.get(run.sportId)!;
      }
    }
    return { dataset: parsed, sensors };
  }

  // 5. Encrypted WCDB or decrypted SQLite database (.db / ygty_mysport.db)
  return extractDatasetFromSqliteBuffer(buf, nearbySensors);
}

function resolveAdbBinary(): string {
  const candidates = [
    process.env.ADB_PATH,
    'adb',
    join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    'D:\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
  ].filter((x): x is string => Boolean(x));

  for (const bin of candidates) {
    if (bin !== 'adb' && !existsSync(bin)) continue;
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
      return bin;
    } catch {
      // try next
    }
  }
  throw new UserError('未找到 adb 工具：请安装 Android Platform-Tools 并加入 PATH，或直接使用 I 导入文件。');
}

function runAdbBuffer(adb: string, args: string[], timeoutMs = 25_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let errText = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new UserError('ADB 操作超时，请检查手机连接状态。'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= 350_000_000) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errText.length < 4096) errText += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new UserError('无法启动 adb 进程。'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr: errText.trim() });
    });
  });
}

export async function pullSportDatasetFromPhone(): Promise<{
  dataset: Dataset;
  sensors: Record<string, number[]>;
  sourceHint: string;
  session?: ExtractedAndroidSession;
}> {
  const adb = resolveAdbBinary();
  const devRes = await runAdbBuffer(adb, ['devices'], 8000);
  const lines = devRes.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .slice(1)
    .map(l => l.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new UserError('未检测到安卓手机：请用数据线连接手机，并在开发者选项中开启「USB 调试」。');
  }
  if (lines.some(l => /\bunauthorized\b/.test(l)) && !lines.some(l => /\bdevice\b/.test(l))) {
    throw new UserError('手机已连接但未授权调试：请在手机屏幕弹窗勾选「允许 USB 调试」后重试。');
  }
  const serials = lines
    .filter(l => /\bdevice\b/.test(l))
    .map(l => l.split(/\s+/)[0]!)
    .filter(Boolean);
  if (!serials.length) {
    throw new UserError(`手机状态不可用（${lines[0]}），请重新插拔或检查 USB 调试。`);
  }

  // 多台安卓设备同时连接时（如电纸书/副机 + 主力手机），并行探测并优先只读装有创高体育的设备
  const probed = await Promise.all(
    serials.map(async s => {
      const probe = await runAdbBuffer(
        adb,
        ['-s', s, 'shell', 'pm path net.crigh.cgsport 2>/dev/null; getprop ro.product.model'],
        5000,
      ).catch(() => undefined);
      const out = probe?.stdout.toString('utf8') ?? '';
      const hasApp = out.includes('package:');
      const modelLine = out.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('package:')).pop() ?? s;
      return { serial: s, hasApp, model: modelLine };
    }),
  );
  const withApp = probed.filter(p => p.hasApp);
  const rankedSerials = withApp.length ? withApp : probed;

  const workDir = join(tmpdir(), `cgsport-adb-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    for (const target of rankedSerials) {
      const serial = target.serial;
      const sArgs = (rest: string[]) => ['-s', serial, ...rest];

      // 顺带拉取外置存储的加速度传感器文件（可读时直接匹配）
      const phoneSensors = new Map<string, number[]>();
      const sensorDirLocal = join(workDir, `sensor-${serial}`);
      await runAdbBuffer(adb, sArgs(['pull', '/sdcard/Android/data/net.crigh.cgsport/files/sensor', sensorDirLocal]), 12_000).catch(() => {});
      await scanNearbySensorDir(workDir, phoneSensors);

      const mergePhoneSensors = <T extends { dataset: Dataset; sensors: Record<string, number[]> }>(loaded: T): T => {
        for (const run of loaded.dataset.runs) {
          if (run.sportId && phoneSensors.has(run.sportId) && !loaded.sensors[String(run.id)]) {
            loaded.sensors[String(run.id)] = phoneSensors.get(run.sportId)!;
          }
        }
        return loaded;
      };

      // 通道 1A：扫描各品牌本地备份与下载目录 (.bak / .tar / .ab / ygty_mysport.db)
      const findDirect = await runAdbBuffer(
        adb,
        sArgs([
          'shell',
          'ls -1t /sdcard/MIUI/backup/AllBackup/*/*.bak /sdcard/MIUI/backup/AllBackup/*.bak ' +
            '/sdcard/Backup/App/*/*cgsport* /sdcard/ColorOS/Backup/*/*cgsport* ' +
            '/sdcard/Huawei/Backup/**/*cgsport* /sdcard/Honor/Backup/**/*cgsport* ' +
            '/sdcard/Download/*mysport*.db /sdcard/Download/*cgsport*.bak /sdcard/Download/*cgsport*.zip /sdcard/Download/*cgsport*.tar /sdcard/Download/*cgsport*.ab 2>/dev/null',
        ]),
        8000,
      ).catch(() => undefined);
      const directCandidates = (findDirect?.stdout.toString('utf8') ?? '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(
          s =>
            /\.(?:bak|tar|ab|db|zip)$/i.test(s) &&
            (s.toLowerCase().includes('cgsport') || s.toLowerCase().includes('mysport') || s.includes('创高体育')),
        );

      for (const remoteFile of directCandidates) {
        const localFile = join(workDir, basename(remoteFile) || 'backup.bak');
        const pullRes = await runAdbBuffer(adb, sArgs(['pull', remoteFile, localFile]), 45_000);
        if (pullRes.code === 0 && existsSync(localFile)) {
          const loaded = mergePhoneSensors(await loadAnySportSource(localFile));
          return { ...loaded, sourceHint: `${target.model} 本地备份` };
        }
      }

      // 通道 1B：扫描小米 HyperOS 压缩备份包 (/sdcard/MIUI/backup/AllBackup/*.zip)
      const findZip = await runAdbBuffer(
        adb,
        sArgs(['shell', 'ls -1t /sdcard/MIUI/backup/AllBackup/*.zip /sdcard/MIUI/backup/AllBackup/*/*.zip 2>/dev/null']),
        8000,
      ).catch(() => undefined);
      const zipCandidates = (findZip?.stdout.toString('utf8') ?? '')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s.endsWith('.zip'));

      for (const remoteZip of zipCandidates) {
        const escaped = remoteZip.replace(/'/g, "'\\''");
        const listRes = await runAdbBuffer(
          adb,
          sArgs(['shell', `stat -c %s '${escaped}' 2>/dev/null; unzip -l '${escaped}' 2>/dev/null || tail -c 65536 '${escaped}'`]),
          8000,
        ).catch(() => undefined);
        const listText = listRes?.stdout.toString('utf8') ?? '';
        if (!listText.includes('net.crigh.cgsport') && !listText.includes('ygty_mysport.db')) continue;

        const firstLineNum = Number(listText.split(/\r?\n/)[0]?.trim());
        const zipSize = Number.isFinite(firstLineNum) && firstLineNum > 0 ? firstLineNum : 0;

        // 体积适中的单独备份包 (<300MB) 直接拉取压缩包最快；超大整机备份包则按精确条目名流式提取 .bak
        if (zipSize > 0 && zipSize <= 300_000_000) {
          const localZip = join(workDir, basename(remoteZip) || 'miui-backup.zip');
          const pullZip = await runAdbBuffer(adb, sArgs(['pull', remoteZip, localZip]), 60_000);
          if (pullZip.code === 0 && existsSync(localZip)) {
            const loaded = mergePhoneSensors(await loadAnySportSource(localZip));
            return { ...loaded, sourceHint: `${target.model} 本地备份包` };
          }
        }

        const entryMatch = /([^\r\n\s]+net\.crigh\.cgsport[^\r\n]*\.bak)/.exec(listText);
        if (entryMatch) {
          const entryEscaped = entryMatch[1]!.replace(/'/g, "'\\''");
          const streamBak = await runAdbBuffer(
            adb,
            sArgs(['exec-out', `unzip -p '${escaped}' '${entryEscaped}'`]),
            60_000,
          ).catch(() => undefined);
          if (streamBak && streamBak.stdout.length > 1024 && streamBak.stdout.subarray(0, 4096).indexOf(ANDROID_BACKUP_MAGIC) >= 0) {
            const tar = unpackAndroidBackupToTar(streamBak.stdout);
            const extracted = extractSportFilesFromTar(tar);
            if (extracted.db) {
              for (const [k, v] of extracted.sensors) phoneSensors.set(k, v);
              const loaded = mergePhoneSensors(await extractDatasetFromSqliteBuffer(extracted.db, phoneSensors));
              return { ...loaded, sourceHint: `${target.model} 本地备份包`, ...(extracted.session ? { session: extracted.session } : {}) };
            }
          }
        }
      }

      // 通道 2：Root 手机或模拟器直接读取 /data/data/net.crigh.cgsport/databases/ygty_mysport.db
      for (const cmd of [
        ['exec-out', 'su', '-c', 'cat /data/data/net.crigh.cgsport/databases/ygty_mysport.db'],
        ['exec-out', 'cat', '/data/data/net.crigh.cgsport/databases/ygty_mysport.db'],
        ['exec-out', 'run-as', 'net.crigh.cgsport', 'cat', 'databases/ygty_mysport.db'],
      ]) {
        const rootRes = await runAdbBuffer(adb, sArgs(cmd), 15_000).catch(() => undefined);
        if (rootRes && rootRes.stdout.length >= PAGE_SIZE && rootRes.stdout.length % PAGE_SIZE === 0) {
          try {
            const loaded = mergePhoneSensors(await extractDatasetFromSqliteBuffer(rootRes.stdout, phoneSensors));
            return { ...loaded, sourceHint: `${target.model} 沙盒直读` };
          } catch {
            // Not a valid DB buffer; try next method
          }
        }
      }

      // 通道 3：仅对确实装有创高体育的设备发起标准 adb backup
      if (target.hasApp) {
        const abFile = join(workDir, `phone-${serial}.ab`);
        await runAdbBuffer(adb, sArgs(['backup', '-f', abFile, '-noapk', 'net.crigh.cgsport']), 45_000).catch(() => {});
        if (existsSync(abFile)) {
          const abStat = await stat(abFile);
          if (abStat.size > 512) {
            const loaded = mergePhoneSensors(await loadAnySportSource(abFile));
            return { ...loaded, sourceHint: `${target.model} ADB 备份` };
          }
        }
      }
    }

    throw new UserError(
      '未读到数据库（非 Root 机型受安卓沙盒限制）：小米/红米请在手机「设置 -> 更多设置 -> 备份与恢复 -> 手机备份」单独勾选「创高体育」备份一次后再按 P 秒读；或按 I 直接选择电脑上的 .bak/.zip/.db 文件。',
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
