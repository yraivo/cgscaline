/**
 * 可插拔签名器。
 *
 * 真实链路：`ChingoEncrypt.cgapiEnrypt(HEADER["SECRET"], signPath)`
 * → 管道符 4 段 `val0|val1|val2|val3`；val1→timestamp header，val3→sign header。
 *
 * 【已确证】（2026-08-01，Unidbg 动态执行 + 真实抓包）：
 *   val1 = splitmix64_no_add(timestamp_ms)   ← 已破解！
 *       x = (x ^ (x >> 30)) * 0xbf58476d1ce4e5b9 mod 2^64
 *       x = (x ^ (x >> 27)) * 0x94d049bb133111eb mod 2^64
 *       x = x ^ (x >> 31)
 *       只依赖毫秒（us/1000 整除），23 个受控样本 100% 复现
 *   val3 = SHA256( real_key + path_processed + timestamp(8B大端ms) + reverse(real_key) )
 *          然后插入 "199st" @ [12,28,36,38,58]
 *   real_key = AES-256-CBC-decrypt(__src[20:52], KEY, IV=__src[4:20])   [无 padding]
 *   AES KEY  = ad8dad2869c5e017303e5f48858db3129bf4d07a47d85beaaaa9d26f436d232a
 *   path_processed = path 去掉 '?'/'='，query 键值对 key+value 拼接（字典序）
 *                   ★ query 值需 URL 解码（+→空格，%XX→字符）——Frida 实测确证
 *                   ★ savesports 签名路径含 jsonsports body（/api/l/v7/savesports?jsonsports=<密文>）
 *   timestamp = 当前毫秒，8 字节大端
 *   "199st"  = 代码硬编码插入常量
 *
 * ⚠️ 本模块使用 node:crypto（AES-CBC 无 padding）。Cloudflare Worker 中
 * WebCrypto 无法做无 padding 解密，NativeSigner 仅适用于 Node 后端。
 */

import { createDecipheriv, createHash } from "node:crypto";

/** 已知的 AES-256 硬编码密钥（Unidbg 确证） */
export const CGAPI_AES_KEY_HEX =
  "ad8dad2869c5e017303e5f48858db3129bf4d07a47d85beaaaa9d26f436d232a";

/** val3 插入字符与位置（Unidbg + 真实样本确证） */
export const VAL3_INSERT_CHARS = "199st";
export const VAL3_INSERT_POS = [12, 28, 36, 38, 58];

export interface SignInput {
  method: string;
  signPath: string;
  body?: string;
}

export interface SignOutput {
  timestamp: string;
  sign: string;
}

export interface Signer {
  readonly name: string;
  sign(input: SignInput): Promise<SignOutput>;
}

/** MockSigner：假签名，只验证请求格式，服务端不会接受 */
export class MockSigner implements Signer {
  readonly name = "mock";

  async sign(input: SignInput): Promise<SignOutput> {
    return { timestamp: "0", sign: `mock-sign:${input.signPath}` };
  }
}

/** 一次真实抓包样本 */
export interface ReplayEntry {
  method: string;
  signPath: string;
  timestamp: string;
  sign: string;
}

/** ReplaySigner：按 signPath 匹配真实抓包样本（预埋） */
export class ReplaySigner implements Signer {
  readonly name = "replay";

  constructor(private readonly entries: ReplayEntry[]) {}

  async sign(input: SignInput): Promise<SignOutput> {
    const entry = this.entries.find(
      (e) => e.method === input.method && e.signPath === input.signPath,
    );
    if (!entry) {
      throw new Error(
        `ReplaySigner: 无 ${input.method} ${input.signPath} 的抓包样本；` +
          "需先在证据中补充对应路径的 ReplayEntry",
      );
    }
    return { timestamp: entry.timestamp, sign: entry.sign };
  }
}

/**
 * NativeSigner：cgapiEnrypt 完整算法（Unidbg 确证）。
 * val1 = splitmix64_no_add(ts_ms)，val3 = SHA256(real_key + path + ts + reverse(real_key)) + "199st"。
 * 未提供 timestampGenerator 时默认按确证公式计算 val1。
 */
export interface NativeSignerOptions {
  /** SECRET（登录 token 第 4 段，base64） */
  secret: string;
  /** val1 生成器覆盖。未提供时用 splitmix64_no_add(ts_ms)（已确证）。 */
  timestampGenerator?: () => string;
  /** AES-256 密钥 hex（默认使用确证值） */
  aesKeyHex?: string;
  /** 测试用：固定时间戳（毫秒），覆盖 Date.now() */
  timestampMs?: bigint;
}

export class NativeSigner implements Signer {
  readonly name = "native";

  constructor(private readonly options: NativeSignerOptions) {}

  async sign(input: SignInput): Promise<SignOutput> {
    // val1 与 val3 共用同一个 ts，避免 1ms 竞态
    const ts = this.options.timestampMs ?? BigInt(Date.now());
    const timestamp = this.options.timestampGenerator
      ? this.options.timestampGenerator()
      : splitmix64NoAdd(ts).toString();

    const val3 = this.buildVal3(input, ts);
    return { timestamp, sign: val3 };
  }

  /** 构造完整 val3：buffer → SHA256 → 插入 "199st" */
  private buildVal3(input: SignInput, ts: bigint): string {
    const buffer = this.buildBuffer(input, ts);
    const sha256Hex = createHash("sha256").update(buffer).digest("hex");
    return insertCharsIntoHex(sha256Hex, VAL3_INSERT_CHARS);
  }

  /** 构造 SHA-256 输入 buffer（Unidbg 确证的 96+ 字节结构） */
  private buildBuffer(input: SignInput, ts: bigint): Buffer {
    const keyBytes = hexToBytes(this.options.aesKeyHex ?? CGAPI_AES_KEY_HEX);
    const src = base64Decode(this.options.secret);
    const iv = src.subarray(4, 20);
    const realKey = aesCbcDecryptNoPad(src.subarray(20, 52), keyBytes, iv);
    const realKeyStr = realKey.toString("utf-8");
    const pathProcessed = processSignPath(input.signPath);
    const tsBytes = bigIntToBytes(ts);
    // comp4 = reverse(real_key)（已确证）
    const comp4 = Buffer.from(realKeyStr.split("").reverse().join(""), "utf-8");

    return Buffer.concat([realKey, Buffer.from(pathProcessed, "utf-8"), tsBytes, comp4]);
  }
}

/**
 * 已确证的 val1 公式：SplitMix64 的 avalanche/finalizer 部分（无 +0x9e3779b97f4a7c15）。
 * 只依赖毫秒时间戳（us/1000 整除），23 个受控样本 100% 复现。
 */
export function splitmix64NoAdd(x: bigint): bigint {
  const MASK = (1n << 64n) - 1n;
  let v = x & MASK;
  v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (v ^ (v >> 31n)) & MASK;
}

/**
 * 已确证的 val3 变换：把 insertChars 按 [12,28,36,38,58] 依次插入 64 hex 串。
 */
export function insertCharsIntoHex(sha256Hex: string, insertChars: string): string {
  const positions = VAL3_INSERT_POS;
  if (sha256Hex.length !== 64) {
    throw new Error(`NativeSigner: SHA-256 hex 应为 64 字符，实际 ${sha256Hex.length}`);
  }
  if (insertChars.length !== 5) {
    throw new Error(`NativeSigner: 插入字符应为 5 个，实际 ${insertChars.length}`);
  }
  let out = sha256Hex;
  for (let i = 0; i < 5; i++) {
    out = out.slice(0, positions[i]) + insertChars[i] + out.slice(positions[i]);
  }
  return out;
}

/**
 * path → path_processed：去掉 '?'/'='，query 键值对 key+value 拼接（字典序）。
 * ⚠️ 已确证（2026-08-01，hook cgapiEnrypt 实测）：query 值必须 **URL 解码**（+ → 空格，%XX → 字符）
 *    —— 与 native http_parse_query_ex 一致。savesports 的 jsonsports 参数含 '+' 需解码。
 */
export function processSignPath(path: string): string {
  const qIdx = path.indexOf("?");
  if (qIdx === -1) return path;
  const base = path.slice(0, qIdx);
  const query = path.slice(qIdx + 1);
  const parts = query.split("&").filter(Boolean);
  const pairs = parts.map((p) => {
    const eq = p.indexOf("=");
    if (eq === -1) return [decodeURIComponentSafe(p), ""] as const;
    return [decodeURIComponentSafe(p.slice(0, eq)), decodeURIComponentSafe(p.slice(eq + 1))] as const;
  });
  pairs.sort((a, b) => ((a[0] ?? "") < (b[0] ?? "") ? -1 : (a[0] ?? "") > (b[0] ?? "") ? 1 : 0));
  return base + pairs.map((kv) => (kv[0] ?? "") + (kv[1] ?? "")).join("");
}

/** URL 解码（+ → 空格，%XX → 字符），失败时原样返回 */
function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/* ---------------------- node:crypto 封装 ---------------------- */

/** AES-256-CBC 解密，无 padding（真实实现行为） */
function aesCbcDecryptNoPad(data: Buffer | Uint8Array, key: Uint8Array, iv: Uint8Array): Buffer {
  const d = createDecipheriv("aes-256-cbc", Buffer.from(key), Buffer.from(iv));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(Buffer.from(data)), d.final()]);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64Decode(s: string): Buffer {
  return Buffer.from(s, "base64");
}

function bigIntToBytes(n: bigint): Buffer {
  const out = Buffer.alloc(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
