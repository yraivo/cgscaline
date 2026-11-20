/**
 * Body 编码器（可插拔）。
 *
 * 真实链路（**已确证 2026-08-01，SSL_write 动态抓包 + 明文对照**）：
 *   `UploadJsonSports` → Gson → JSON 明文
 *   → `彐叐凴瀱砰漆摯.秪踖拽炅鮤幕諭紨伟(json, SECRET.substring(0,16), 0)`
 *   → **AES-128-ECB**（无 IV，PKCS7 填充）→ Base64
 *   → 表单字段 `jsonsports` 提交。
 *
 * 之前的 AES-CBC/零 IV 推断是**错的**（服务端 400 解密失败）；实际抓包证实为 ECB。
 * NativeEncoder 用 node:crypto（与 signer.ts 一致；Cloudflare Worker 不可用）。
 */

import { createCipheriv } from "node:crypto";

export interface BodyEncoder {
  readonly name: string;
  encode(json: string): Promise<string>;
}

/** PassthroughEncoder：原样返回 JSON 明文（mock 用，服务端不会接受） */
export class PassthroughEncoder implements BodyEncoder {
  readonly name = "passthrough";

  async encode(json: string): Promise<string> {
    return json;
  }
}

/**
 * NativeEncoder：Body 加密（**AES-128-ECB / PKCS7 / Base64**，node:crypto）。
 * 已确证：抓包 jsonsports 用 AES-128-ECB(SECRET[:16]) 完美解出明文 JSON。
 */
export class NativeEncoder implements BodyEncoder {
  readonly name = "native";

  /** AES-128 密钥（SECRET 前 16 字符，ASCII 字节） */
  constructor(private readonly secret: string) {}

  async encode(json: string): Promise<string> {
    if (!this.secret || this.secret.length < 16) {
      throw new Error("NativeEncoder: 需要 32 字符的 SECRET（取前 16 作 AES 密钥）");
    }
    const key = Buffer.from(this.secret.slice(0, 16), "utf-8");
    // AES-128-ECB：无 IV，node:crypto 空 IV 即可；默认 PKCS7 填充
    const cipher = createCipheriv("aes-128-ecb", key, "");
    const encrypted = Buffer.concat([cipher.update(json, "utf-8"), cipher.final()]);
    return encrypted.toString("base64");
  }
}
