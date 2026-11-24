import type { BindingChange } from './device-identity.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { androidIdToImei, buildUserAgent } from '../protocol/device.js';
import type { UploadJsonSports } from '../protocol/types.js';
import type { WorkoutRecord } from '../protocol/records.js';
import type { AccountInformation, RecordDetail } from '../campus/information.js';
import type { ActivityEntry } from './activity.js';
import { DEFAULT_BASE_URL, DEFAULT_SCHOOL_PROFILE, type SchoolProfile } from '../campus/school-profile.js';

export const BASE = DEFAULT_BASE_URL;
export const UPDATE_BASE = 'https://tyapp.chingo.cn/cgapp/';
export const PROTOCOL_REVISION = 'cgsport-legacy-3.0.0/2';
export type SourceMode = 'private' | 'public';
export type RecordScope = 'current' | 'archive';
export type ColorTheme = 'astolfo' | 'spectrum' | 'mescaline' | 'acid';
export type LogoFont = 'plain' | 'figlet:The Edge';
export type VisualStyle = 'track' | 'spiral' | 'none';
export type Language = 'zh' | 'en';

export interface Device {
  androidId: string; manufacturer: string; model: string;
  androidRelease: string; sdk: string; buildId: string; appVersion: string;
}
export const defaultDevice = (): Device => ({
  androidId: randomBytes(8).toString('hex'), manufacturer: 'Xiaomi', model: 'M2007J3SC',
  androidRelease: '11', sdk: '30', buildId: 'RKQ1.200826.002', appVersion: '3.0.0',
});
const headerCache = new Map<string, { imei: string; userAgent: string }>();
export const deviceHeaders = (d: Device) => {
  const key = `${d.androidId}\0${d.appVersion}\0${d.androidRelease}\0${d.manufacturer}\0${d.buildId}`;
  let cached = headerCache.get(key);
  if (!cached) {
    cached = {
      imei: androidIdToImei(d.androidId),
      userAgent: buildUserAgent({ appVersion: d.appVersion, androidRelease: d.androidRelease,
        manufacturer: d.manufacturer, buildId: d.buildId }),
    };
    if (headerCache.size > 256) headerCache.delete(headerCache.keys().next().value!);
    headerCache.set(key, cached);
  }
  return { imei: cached.imei, userAgent: cached.userAgent };
};
export const phoneVersion = (d: Device) => `${d.model},${d.sdk},${d.androidRelease}|${d.appVersion}`;
export interface Session {
  id: string; token: string; secret: string; loginOutTime: string;
  xh: string; name: string; gender: string; identity: string; createdAt: number;
  status: 'saved' | 'verified' | 'invalid';
}
export interface Compatibility {
  status: 'ok' | 'update' | 'unknown'; checkedAt: number; key: string; note: string;
}
export interface PersistedRecordCache {
  identity: string; sessionId: string; fetchedAt: number;
  records: WorkoutRecord[];
  archiveFetchedAt?: number; archiveRecords?: WorkoutRecord[];
  details?: Record<string, RecordDetail>;
}
export interface AccountSchool {
  id: string; provinceCode: string; randomCode: string; baseUrl: string;
  name?: string; nameEn?: string; code?: string; loginType?: string; loginUrl?: string;
}
export type DeviceSource = 'existing' | 'tui' | 'manual' | 'portable' | 'phone';
export type DeviceUsage = 'unused' | 'attempted' | 'unknown';
export interface Account {
  id: string; label: string; username: string;
  school: AccountSchool;
  device: Device; proxy: string; routeId: string; sourceMode: SourceMode; libraryId?: string;
  session?: Session; compatibility?: Compatibility; lastLoginAt?: number;
  bindingConflict?: boolean;
  deviceSource?: DeviceSource; deviceUsage?: DeviceUsage; deviceRevision?: number;
  information?: AccountInformation; recordCache?: PersistedRecordCache;
}
type IdentityFields = Pick<Account, 'username' | 'school' | 'device' | 'proxy'>;
export function canonicalDevice(d: Device): Device {
  return { androidId: d.androidId, manufacturer: d.manufacturer, model: d.model, androidRelease: d.androidRelease,
    sdk: d.sdk, buildId: d.buildId, appVersion: d.appVersion };
}
function hashIdentity(a: IdentityFields, device: Device) {
  const { id, provinceCode, randomCode, baseUrl } = a.school;
  return createHash('sha256').update(JSON.stringify({
    username: a.username, school: { id, provinceCode, randomCode, baseUrl }, device, proxy: a.proxy,
  })).digest('hex');
}
export const identity = (a: IdentityFields) => hashIdentity(a, canonicalDevice(a.device));
/** Accept only a digest that could be produced from this exact persisted profile. */
export function migrateIdentity(a: Account, tasks: Task[] = []) {
  const canonical = identity(a);
  const { androidId, ...profile } = canonicalDevice(a.device);
  const older = new Set([hashIdentity(a, a.device), hashIdentity(a, { ...profile, androidId })]);
  older.delete(canonical);
  const matches = (value?: string) => value !== undefined && older.has(value);
  if (!older.size) return;
  if (a.session && matches(a.session.identity)) a.session.identity = canonical;
  if (a.information && matches(a.information.identity) && a.information.sessionId === a.session?.id) a.information.identity = canonical;
  if (a.recordCache && matches(a.recordCache.identity) && a.recordCache.sessionId === a.session?.id) a.recordCache.identity = canonical;
  for (const task of tasks) {
    if (activeTask(task) && task.accountId === a.id && task.sessionId === a.session?.id && matches(task.identity)) {
      task.identity = canonical;
      if (matches(task.prepared.accountIdentity)) task.prepared = { ...task.prepared, accountIdentity: canonical };
    }
  }
}
export function deviceUsage(a: Account): DeviceUsage {
  if (a.session || a.lastLoginAt !== undefined || a.deviceUsage === 'attempted') return 'attempted';
  return a.deviceUsage === 'unused' ? 'unused' : 'unknown';
}
export const compatibilityKey = (a: Account) => `${a.school.baseUrl}:${a.school.id}:${a.device.appVersion}:${PROTOCOL_REVISION}`;
export interface Library {
  id: string; label: string; scope: SourceMode; ownerAccountId?: string;
  schoolBaseUrl?: string; schoolName?: string; schoolId?: string;
  attribution?: 'matched' | 'mismatch' | 'unverified'; modelHint?: string;
  runCount: number; routeIds: string[]; importedAt: number;
}
export function canUseLibrary(
  l: Library,
  a: Pick<Account, 'id' | 'sourceMode'> & { school?: Pick<AccountSchool, 'baseUrl'> & { id?: string } },
) {
  if (l.scope !== a.sourceMode) return false;
  if (l.schoolId && a.school?.id && l.schoolId !== a.school.id) return false;
  if (l.schoolBaseUrl && a.school?.baseUrl && l.schoolBaseUrl !== a.school.baseUrl) return false;
  return l.scope !== 'private' || l.ownerAccountId === a.id;
}
export function cachedInformation(a:Pick<Account,'username'|'school'|'device'|'proxy'|'information'>&{session?:Pick<Session,'id'>}):AccountInformation|undefined{
 const info=a.information;return info?.identity===identity(a)&&info.sessionId===a.session?.id?info:undefined;
}
export interface Prepared {
  body: UploadJsonSports; sensor: number[]; routeId: string; libraryId: string;
  sourceRunId: number; seed: number; durationSec: number; sensorSource: 'recorded' | 'generated';
  sourceDistanceKm?: number;
  rawGeometryMeters?: number; rawGeometryCoverage?: 'partial' | 'unavailable';
  accountIdentity?: string; deviceRevision?: number; preparedSessionId?: string;
  candidateCount?:number;sourceDurationSec?:number;targets?:OneShotTargets;
  fit?:{sourceWindowSec:number;timeScale:number};
  generation?:'auto'|'manual'|'legacy';
  coordinateCount?:number;
  sensorSampleCount?:number;
  previewWarnings?:string[];
}
export interface OneShotTargets {distanceKm?:number;durationSec?:number}
export type TaskPhase = 'queued' | 'starting' | 'waiting' | 'committing' | 'paused' | 'review' | 'done' | 'abandoned';
export interface Task {
  id: string; accountId: string; accountLabel: string; identity: string; sessionId: string;
  createdAt: number; phase: TaskPhase; prepared: Prepared; note: string;
  plannedStartAt?: number; resumePhase?: 'queued' | 'waiting';
  autoAuditAt?: number;
  steps?: Array<{ endpoint: string; at: number; httpStatus: number; code?: number }>;
  session?: { sportId: string; startAtMs: number; endAtMs: number; commitAtLocalMs?: number; clockOffsetMs?: number };
  result?: { accepted: boolean; businessValid: boolean; sportId: string; code?: number;
    isValid?: string; checkStatus?: string; reason?: string };
  audit?: { checkedAt:number; found:boolean; record?:import('../protocol/records.js').WorkoutRecord; recordAt?:number };
}
export interface State {
  pendingBindings?: BindingChange[];
  runtimeMode?:'demo';
  schemaVersion: 1; accounts: Account[]; libraries: Library[]; tasks: Task[];
  activity?: ActivityEntry[];
  settings: {
    maxConcurrent: number; notifications?:boolean; termTarget?: number;
    defaultSchool?: AccountSchool; schoolId?: string; schoolProxy?: string; schoolName?: string; schoolNameEn?: string; compatibility?: Compatibility;
    colorTheme?: ColorTheme; logoFont?: LogoFont; visualStyle?: VisualStyle;
    visualOpacity?: number; gradientSpeed?: number; animationFps?:number;
    motion?: boolean; privacyMode?: boolean; language?: Language;
  };
}
export const emptyState = (): State => ({ schemaVersion: 1, accounts: [], libraries: [], tasks: [], settings: { maxConcurrent: 2 } });
export const activeTask = (t: Pick<Task,'phase'>) => !['done', 'abandoned'].includes(t.phase);
export const newAccount = (label: string, username: string, schoolId: string, profile: SchoolProfile = DEFAULT_SCHOOL_PROFILE, device: Device = defaultDevice()): Account => ({
  id: randomUUID(), label, username,
  school: { id: schoolId, provinceCode: profile.provinceCode, randomCode: profile.randomCode, baseUrl: profile.baseUrl },
  device, proxy: '', routeId: profile.defaultRouteId, sourceMode: 'private',
});
export class UserError extends Error {}
export function safeText(v: unknown, max = 180): string {
  return String(v ?? '').replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, max);
}
