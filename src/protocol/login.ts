/**
 * 登录复现（2026-08-01 逆向确证）—— viewer「账号+密码」自动登录的基础。
 *
 * 已确证（Frida MessageDigest hook + SSL_write 抓包）：
 *   1. 密码加密 = AES-128-ECB(password + PKCS7, key="6d3121b650e42855") → base64
 *        key = m3453 = "6d31"+"21b6"+ak3("50e4")+LCM(5,571)
 *   2. 登录 sign = MD5( app_secret + "/api/f/v6/login" + 排序KV(排除app_key/sign/timestamp)
 *                      + timestamp + " " + app_secret )
 *        app_secret = "262b6c001ea05beceb9d560be1dbf14f"
 *   3. 表单：app_key="azk3t4jrcfm5772t", password, provinceCode, randomCode,
 *      sign, timestamp, userAgent, username, version="3.0.0"
 *   4. 响应 data.token 点分 5 段：[0..2]=JWT(TOKEN), [3]=SECRET, [4]=LOGIN_OUT_TIME
 */

import { createCipheriv } from "node:crypto";
import { createHash } from "node:crypto";

export const LOGIN_APP_KEY = "azk3t4jrcfm5772t";
export const LOGIN_APP_SECRET = "262b6c001ea05beceb9d560be1dbf14f";
export const PASSWORD_AES_KEY = "6d3121b650e42855";
export const LOGIN_PATH = "api/f/v6/login";
export const LOGIN_VERSION = "3.0.0";
export const LOGIN_USER_AGENT = "cgapp/3.0.0(Linux;Android 11;Xiaomi/RKQ1.200826.002)";

/** 密码加密：AES-128-ECB(password + PKCS7, 固定key) → base64 */
export function encryptPassword(password: string): string {
  const key = Buffer.from(PASSWORD_AES_KEY, "utf-8");
  const cipher = createCipheriv("aes-128-ecb", key, "");
  const ct = Buffer.concat([cipher.update(password, "utf-8"), cipher.final()]);
  return ct.toString("base64");
}

/**
 * client 请求头（C0363.m3417 逆向确证）：
 * `AES-128-ECB( JSON{"heap":"0","root":"0","t":"<ms>"} + PKCS7, SECRET[:16] )` → base64
 * 验证：用 SECRET="AAAAN***"（脱敏）+ t=1785577396044 → "bXjaxqpBIIluMhMI..."（与抓包逐字符一致）。
 * root="1" 表示已 root；heap="1" 表示前台类变化（正常 "0"）。
 */
export function buildClient(secret: string, tMs?: number, opts: { root?: boolean } = {}): string {
  const t = String(tMs ?? Date.now());
  const json = `{"heap":"0","root":"${opts.root ? "1" : "0"}","t":"${t}"}`;
  const key = Buffer.from(secret.slice(0, 16), "utf-8");
  const cipher = createCipheriv("aes-128-ecb", key, "");
  const ct = Buffer.concat([cipher.update(json, "utf-8"), cipher.final()]);
  return ct.toString("base64");
}

export interface LoginSchoolConfig {
  /** 学校 provinceCode */
  provinceCode: string;
  /** 学校 randomCode */
  randomCode: string;
}

export const DEFAULT_SCHOOL: LoginSchoolConfig = { provinceCode: "00", randomCode: "00" };

/** 登录 sign：MD5(app_secret + path + 排序KV + ts + " " + app_secret) */
export function buildLoginSign(fields: Record<string, string>, timestamp: string): string {
  // 参与签名的字段：排除 app_key / sign / timestamp（登录签名实测只含 password..version）
  const keys = Object.keys(fields)
    .filter((k) => k !== "app_key" && k !== "sign" && k !== "timestamp")
    .sort();
  const kv = keys.map((k) => k + fields[k]!).join("");
  const base = LOGIN_APP_SECRET + `/${LOGIN_PATH}` + kv + timestamp + " " + LOGIN_APP_SECRET;
  return createHash("md5").update(base, "utf-8").digest("hex");
}

export interface LoginResult {
  ok: boolean;
  httpStatus?: number;
  /** 登录响应 code */
  code: number;
  message: string;
  /** JWT（cgAuthorization 头） */
  token: string;
  /** 会话 SECRET（登录 token 第 4 段，sign 链/加密用） */
  secret: string;
  /** 登录过期时间（第 5 段） */
  loginOutTime: string;
  /** 用户信息（可选） */
  userInfo?: Record<string, unknown>;
}

export interface LoginOptions {
  baseUrl?: string;
  school?: LoginSchoolConfig;
  userAgent?: string;
  version?: string;
  /** 同一设备档案应贯穿登录、查询与提交。缺省保持旧客户端行为。 */
  imei?: string;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

/**
 * 完整登录：加密密码 → 构造表单 → 计算 sign → POST → 解析 token。
 * ⚠️ 真实登录会创建新会话（可能使 VM 里当前会话失效）；仅测试账号使用。
 */
export async function login(
  username: string,
  password: string,
  opts: LoginOptions = {},
): Promise<LoginResult> {
  const base = (opts.baseUrl ?? "https://cgapp.chingo.cn/cgapp-server/").replace(/\/?$/, "/");
  const school = opts.school ?? DEFAULT_SCHOOL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const version = opts.version ?? LOGIN_VERSION;
  const userAgent = opts.userAgent ?? LOGIN_USER_AGENT;

  const ts = String(Date.now());
  const encrypted = encryptPassword(password);

  const fields: Record<string, string> = {
    app_key: LOGIN_APP_KEY,
    password: encrypted,
    provinceCode: school.provinceCode,
    randomCode: school.randomCode,
    timestamp: ts,
    userAgent,
    username,
    version,
  };
  fields.sign = buildLoginSign(fields, ts);

  // 表单按字母序（TreeMap），与服务端一致
  const form = new URLSearchParams();
  for (const k of Object.keys(fields).sort()) form.append(k, fields[k]!);

  const resp = await fetchImpl(base + LOGIN_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      imei: opts.imei ?? "00000000-267c-21f8-267c-21f800000000",
      timestamp: ts,
      sign: fields.sign,
      "User-Agent": userAgent,
      "app-key": LOGIN_APP_KEY,
    },
    body: form,
  });
  const api = (await resp.json()) as {
    code: number;
    message: string;
    data?: { token?: string; info?: Record<string, unknown> };
  };
  if (!resp.ok || api.code !== 200 || !api.data?.token) {
    return { ok: false, httpStatus:resp.status, code: api.code, message: api.message, token: "", secret: "", loginOutTime: "" };
  }
  const parts = api.data.token.split(".");
  if (parts.length < 5) {
    return { ok: false, httpStatus:resp.status, code: api.code, message: "token 分段异常", token: "", secret: "", loginOutTime: "" };
  }
  return {
    ok: true,
    httpStatus:resp.status,
    code: api.code,
    message: api.message,
    token: parts.slice(0, 3).join("."),
    secret: parts[3]!,
    loginOutTime: parts[4]!,
    userInfo: api.data.info,
  };
}
