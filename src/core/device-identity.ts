import { randomBytes } from 'node:crypto';
import { androidIdToImei } from '../protocol/device.js';
import type { Account } from './model.js';

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
export function allocateAndroidId(accounts: readonly Account[], next = () => randomBytes(8).toString('hex')): string {
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
