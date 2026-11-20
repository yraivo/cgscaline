import { createHash } from 'node:crypto';
import { UPDATE_BASE } from '../core/model.js';

// 客户端内置公共服务常量，不是账号会话凭据。
const APP_KEY = 'cgsoft';
const APP_SECRET = '6d3121b650e42855976d0f70dd2048e4';
const SIGN_PATH = '/api/version';

/** 构造公共版本检查请求（不携带任何账号凭据或设备标识）。 */
export function publicVersionRequest(appVersion: string, schoolId: string, now = Date.now()) {
  const fields: Record<string, string> = { versionName: appVersion, systemType: '2', schoolid: schoolId };
  const timestamp = String(now);
  const kv = Object.keys(fields).sort().map(key => key + fields[key]).join('');
  const sign = createHash('md5').update(APP_SECRET + SIGN_PATH + kv + timestamp + ' ' + APP_SECRET).digest('hex');
  const query = new URLSearchParams({ ...fields, app_key: APP_KEY, timestamp, sign });
  return { url: `${UPDATE_BASE}api/version?${query}`, headers: { Accept: 'application/json', 'app-key': APP_KEY } };
}
