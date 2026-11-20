/**
 * 设备级请求头生成器 —— 复现 App 真实逻辑（逆向确证 2026-08-04）。
 *
 * 纯 JS 实现（无 node 依赖）：viewer 浏览器端可直接导入（经 cgsport-scaffold/device）。
 *
 * 依据：
 *  - imei（DeviceUtils.m3419/m3418）：
 *      m3414() = Settings.Secure.getString("android_id")
 *      → 非空则 UUID(android_id.hashCode(), hashCode<<32)
 *      （实测：spoof android_id "c1f2d3e4a5b67890" hashCode=0x267c21f8
 *        → "00000000-267c-21f8-267c-21f800000000" 与抓包逐字符一致）
 *  - v1（DeviceUtils.m3415）：
 *      读 SP key_v1 缓存 → 空则 MD5(String.valueOf(System.currentTimeMillis()))
 *      （抓包两次请求 v1 不同 → 无缓存时每次动态）
 *  - User-Agent（BaseApplication.setUserAgent）：
 *      String.format("cgapp/%s(Linux;Android %s;%s/%s)",
 *        appVersion, Build.VERSION.RELEASE, Build.MANUFACTURER, Build.ID)
 */

/** Java String.hashCode()（有符号 32 位） */
export function javaHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** UUID(msb=hashCode, lsb=hashCode<<32) 标准字符串 */
export function androidIdToImei(androidId: string): string {
  const h = BigInt.asUintN(64, BigInt(javaHashCode(androidId)));
  const lsb = BigInt.asUintN(64, BigInt(javaHashCode(androidId)) << 32n);
  const hex =
    h.toString(16).padStart(16, "0") + lsb.toString(16).padStart(16, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---------------- 纯 JS MD5（标准实现，浏览器可用） ---------------- */

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296),
);
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function md5(input: string): string {
  // UTF-8 编码
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;

  // 填充: 0x80 + 0x00... + 64-bit 长度(小端)
  // ★ 2026-08-25 修复：len%64 ≥ 56 时数据+0x80+8字节长度 > 64，需多分配一个 block，
  //   否则长度字段覆盖 0x80/数据（原实现此区间产出错误哈希）。
  const padBlocks = bytes.length % 64 >= 56
    ? Math.floor(bytes.length / 64) + 2
    : Math.floor(bytes.length / 64) + 1;
  const padded = new Uint8Array(padBlocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dataView = new DataView(padded.buffer);
  dataView.setUint32(padded.length - 8, bitLen >>> 0, true);
  dataView.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true);

  const words: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(dataView.getUint32(i, true));
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const rotateLeft = (x: number, c: number) =>
    ((x << c) | (x >>> (32 - c))) >>> 0;

  for (let block = 0; block < words.length / 16; block += 1) {
    const base = block * 16;
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      // RFC 1321: a' = b + ROTL(a + F(b,c,d) + M[g] + K[i], s)
      const temp = (a + f + MD5_K[i]! + (words[base + g] ?? 0)) >>> 0;
      const nextA = (b + rotateLeft(temp, MD5_S[i]!)) >>> 0;
      // 标准 MD5 轮换：(a,b,c,d) → (旧d, nextA, 旧b, 旧c)
      a = d;
      d = c;
      c = b;
      b = nextA;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const toHex = (n: number) => {
    const hex = n.toString(16).padStart(8, "0");
    return hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2);
  };
  return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

/**
 * v1 请求头生成（DeviceUtils.m3415 + UploadJsonSports.build L220-222）：
 *  - 常规请求（SP["key_v1"] 为空）：v1 = MD5(String.valueOf(System.currentTimeMillis()))
 *  - savesports 请求（UploadJsonSports.build(sportBean, true) 写入 key_v1 = this.odometer，
 *    响应后 SportUploadPresenter.m1292 立即清空 key_v1 = ""）：
 *    v1 = MD5(String(this.odometer))（如 MD5("0.0") = "30565a8911a6bb487e3745c0ea3c8224"）
 */
export function buildV1(tMs?: number, keyV1?: string): string {
  if (keyV1 !== undefined && keyV1 !== "") {
    return md5(String(keyV1));
  }
  return md5(String(tMs ?? Date.now()));
}

/** 纯 JS MD5（导出供验证向量测试；浏览器/Node 通用） */
export function md5Hex(input: string): string {
  return md5(input);
}

export interface UserAgentOptions {
  /** App 版本，如 "3.0.0" */
  appVersion?: string;
  /** Android release，如 "11" */
  androidRelease?: string;
  /** Build.MANUFACTURER，如 "Xiaomi" */
  manufacturer?: string;
  /** Build.ID，如 "RSR1.240422.006" */
  buildId?: string;
}

/** User-Agent 公式：cgapp/{版本}(Linux;Android {release};{manufacturer}/{buildId}) */
export function buildUserAgent(opts: UserAgentOptions = {}): string {
  const {
    appVersion = "3.0.0",
    androidRelease = "11",
    manufacturer = "Xiaomi",
    // 保留项目既有档案的缺省值。此处只构造请求字段，
    // 不据此推断机型真实性、服务端型号白名单或硬件认证策略。
    buildId = "RKQ1.200826.002",
  } = opts;
  return `cgapp/${appVersion}(Linux;Android ${androidRelease};${manufacturer}/${buildId})`;
}
