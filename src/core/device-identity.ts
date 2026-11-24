import { randomBytes } from 'node:crypto';
import { androidIdToImei } from '../protocol/device.js';
import { canonicalDevice, UserError, type Device, type DeviceSource, type DeviceUsage, type Account } from './model.js';

export const LEGACY_ANDROID_ID = 'c1f2d3e4a5b67890';
const reserved = new Set([
  androidIdToImei(LEGACY_ANDROID_ID),
  'ffffffff-8fbc-fbeb-8fbc-fbeb00000000',
]);
export function deviceConflicts<T extends Pick<Account,'id'|'device'>>(a: Pick<Account,'id'|'device'>, accounts: readonly T[]): T[] {
  const androidId = a.device.androidId.toLowerCase();
  const imei = androidIdToImei(a.device.androidId);
  return accounts.filter(other => other.id !== a.id && (
    other.device.androidId.toLowerCase() === androidId || androidIdToImei(other.device.androidId) === imei
  ));
}
/** 新身份只生成一次再持久化；原 ID 和 32 位派生哈希都不能与其他账号重复。 */
export function allocateAndroidId(accounts: readonly Pick<Account, 'device'>[], next = () => randomBytes(8).toString('hex')): string {
  const ids = new Set(accounts.map(a => a.device.androidId.toLowerCase()));
  const imeis = new Set(accounts.map(a => androidIdToImei(a.device.androidId)));
  for (let attempt = 0; attempt < 256; attempt++) {
    const value = next().toLowerCase();
    if (!/^[a-f\d]{16}$/.test(value) || /^0+$/.test(value) || ids.has(value)) continue;
    const imei = androidIdToImei(value);
    if (!imeis.has(imei) && !reserved.has(imei)) return value;
  }
  throw new Error('Unable to allocate unique local device identity');
}

export function accountKey(a: Pick<Account, 'school' | 'username'>): string {
  const url = new URL(a.school.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new UserError('学校服务地址无效。');
  return JSON.stringify([url.href.replace(/\/?$/, '/'), a.username]);
}

export function validDevice(d: Device): boolean {
  if (!d || typeof d !== 'object') return false;
  return Object.values(canonicalDevice(d)).every(v => typeof v === 'string' && v.length > 0 && v.length <= 64) &&
    /^[a-f\d]{16}$/i.test(d.androidId) && !/^0+$/.test(d.androidId) && /^\d+$/.test(d.sdk) &&
    /^[a-zA-Z0-9_. -]+$/.test(d.model) && d.model === d.model.trim() &&
    [d.manufacturer, d.androidRelease, d.buildId, d.appVersion].every(v => /^[a-zA-Z0-9_.-]+$/.test(v));
}

export const sameDevice = (a: Device, b: Device) =>
  JSON.stringify(canonicalDevice(a)) === JSON.stringify(canonicalDevice(b));

export interface Binding {
  key: string;
  tenantId: string;
  device: Device;
  source: DeviceSource;
  usage: DeviceUsage;
  version: number;
  updatedAt: number;
  alternatives: Device[];
}
export interface BindingChange { before?: Binding; after: Binding }
