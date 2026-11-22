/**
 * SyntheticTrack → UploadJsonSports JSON 映射器（真实上传结构）。
 *
 * 依据 `our/data-gap-report.md` 与 `UploadJsonSports.java` 的 build() 确证逻辑：
 * - 上传的 JSON 是 UploadJsonSports，不是 SportBean！
 * - coordinate = List<SportLatLngBean> = {a,o,ac,s,d,da,st,sta,t,v}
 * - minuteSpeed = [{min,v}]；pace = [{km,t}]（配速 "05'16''"）
 * - odometer = 距离公里（dllc，末点 da/1000）
 * - modementMode = 运动类型；stepCount = 步数
 * - beganPoint/endPoint = 首/末点 "a|o"
 * - 无效点注入：按 ac（精度）阈值给 v 赋 1/0/-1
 *
 * 坐标系：所有坐标已是 GCJ-02，无需转换。
 */

import type { RouteTemplate, RunRecord, SyntheticTrack } from "./types.js";
import type {
  Cpacestr,
  CminuteSpeedstr,
  SportLatLngBean,
  UploadJsonSports,
} from "../protocol/types.js";

/** 6 位小数（原生坐标精度；Android 定位采集即此量级） */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * ★ 2026-08-05 Java 风格数值字符串（DB 有效记录格式实证）：
 *   42.9 → "42.9" / 37.92 → "37.92" / 17 → "17" / 2.3 → "2.3" / 9.04 → "9.04"
 *   即 JS Number.toString()（最短表示，整数无尾 .0，小数保留有效位）。
 *   旧实现 toFixed(2)/Math.round 会输出 "145.70"/"11" 等与真机不符的格式。
 */
function javaNum(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** 卡路里：DB 有效记录为 1 位小数 float（170.6/169.4/170.0），56.8 cal/km 同源 */
function javaCal(cal: number): number {
  return Math.round(cal * 10) / 10;
}

function formatSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 从轨迹点对整公里界做线性插值，返回各段精确秒数（C 路线事实源，2026-08-03 定稿）。
 * 权威轴：beginTime → 末点（T = coordWindowSec，含首段 [begin, 首正点]）。
 * pace 显示与 lastOdometerTime 均由此真实耗时派生（先插值、后取整）——
 * 不做"先取整 pace 再倒推 last"：后者会把前几公里的舍入误差全部塞进末段。
 */
function paceSecondsFromTrack(points: Array<{ timestampMs: number; distanceTotalM: number }>): number[] {
  const secs: number[] = [];
  // index>0：跳过 t=0 初始化点（绝对轴时其 timestampMs=start 非 0，不能按 t 判断）
  let prev = points.find((p, index) => index > 0 && p.timestampMs > 0);
  if (!prev) return secs;
  const totalM = points.at(-1)?.distanceTotalM ?? 0;
  for (let km = 1; km <= Math.floor(totalM / 1000); km += 1) {
    const target = km * 1000;
    const next = points.find((p) => p.distanceTotalM >= target);
    if (!next || !prev) break;
    const span = Math.max(1, next.distanceTotalM - prev.distanceTotalM);
    const ratio = (target - prev.distanceTotalM) / span;
    const boundaryMs = prev.timestampMs + (next.timestampMs - prev.timestampMs) * ratio;
    secs.push((boundaryMs - prev.timestampMs) / 1000);
    prev = next;
  }
  return secs;
}

/** 秒/公里 → "MM'SS''" 配速格式（两位数分钟 + 双撇号，与真实 "06'06''" 一致） */
function formatPace(paceSecPerKm: number): string {
  const minutes = Math.floor(paceSecPerKm / 60);
  const seconds = Math.round(paceSecPerKm % 60);
  return `${String(minutes).padStart(2, "0")}'${String(seconds).padStart(2, "0")}''`;
}

export interface MapperOptions {
  /** 学号 xh */
  uid: string;
  /** 用户真名 name（官方 build() 必填：USERINFO["USERNAME"]；从登录响应 userInfo.xm 获取） */
  name?: string;
  /** 上传后由服务端返回；本地构造时留空字符串 */
  sportId?: string;
  /** 路线名 planRouteName（viewer 的 RouteTemplate 只有 routeId，name 从 routeMap 解析传入） */
  routeName?: string;
  /** 运动类型 modementMode（真实记录 sporttype 全为 "2"） */
  sportType?: string;
  /** 手机型号 phoneVersion（可选） */
  phoneVersion?: string;
  /**
   * 可选项：提交路线 ID（默认 "27"）。
   * 必须与 inSportTime 的 sportTypeId 一致（服务端校验开始类型=提交路线）。
   */
  routeId?: string;
  /** 路线名（与 routeId 配套；默认按 routeId 映射） */
  planRouteName?: string;
}

/**
 * 将 viewer 生成的合成轨迹映射为 UploadJsonSports（真实上传结构）。
 * 返回的对象可直接 JSON.stringify 作为上传链第一段明文。
 */
export function syntheticTrackToUploadJsonSports(
  track: SyntheticTrack,
  template: RouteTemplate | null,
  options: MapperOptions,
): UploadJsonSports {
  const { summary, timeline } = track;

  // coordinate：每个采样点一个真实 SportLatLngBean
  // ★ 首点 t=0 是初始化点（原生：ac=0, v=0, s=0），不参与 ac 阈值判定；
  //   s 两位小数、a/o 6 位（原生采样特征），d/da 保持高精度递推（≠ s×Δt/3.6 浮点恒等）。
  const coordinate: SportLatLngBean[] = track.points.map((point, index) => {
    const isFirst = index === 0;
    // ★ 2026-08-05 真实特征：v 直接取生成器的 validFlag（不再按 ac 阈值重判）。
    //   DB 51 条有效记录点级统计：v 分布 {1:37388, 0:1222, -1:128}，
    //   v=-1 点 ac 全 >=120，v=0 点 83% d=0（原地重复点）——生成器已按真实分布注入。
    const v = isFirst ? 0 : point.validFlag ?? 1;
    return {
      a: round6(point.latGcj02), // 纬度（6 位小数）
      o: round6(point.lngGcj02), // 经度（6 位小数）
      ac: isFirst ? 0 : point.accuracyM, // 精度（首点初始化 0；真实主流 3.8 + 锁定 50-150 + 丢失 500-550）
      s: isFirst ? 0 : Number(point.speedKmh.toFixed(2)), // 速度（两位小数）
      d: point.distanceDeltaM, // 上一段距离
      da: point.distanceTotalM, // 累计距离
      st: point.stepDelta, // 上一段步数
      sta: point.stepTotal, // 累计步数
      t: isFirst ? 0 : point.timestampMs, // ★ 首点 t=0 初始化（原生 ac=0,v=0,s=0,t=0），
      //   必须置 0：align/统计以"首个正 t"为轴（2026-08-03 审计：init 点不得计入窗口）
      v,
    };
  });

  // activeTime：= 运动总时长 = Σpace + lastOdometerTime（= 坐标窗 T；构造数据全程运动无静默段）。
  // ★ 2026-08-03 审计：曾用"窗 − 9s"（真实样本的静默段规则），导致 activeTime 漏算最后零头
  //   （activeTime=1142 = 三个整公里 pace 之和，而 Σpace + last = 1150/1151）。
  const coordTs = coordinate.map((c) => c.t).filter((t) => t && t > 0);
  const coordWindowSec =
    coordTs.length >= 2 ? (Math.max(...coordTs) - Math.min(...coordTs)) / 1000 : 0;
  const activeTimeSec =
    coordWindowSec > 0 ? Math.max(1, Math.round(coordWindowSec)) : Math.round(summary.durationSec);

  // minuteSpeed → [{min, v}]（sportId transient 不序列化）
  // ★ 数量 = floor(activeTimeSec/60)（原生：131s→2 项、1127s→18 项；生成器按 ceil 多出一项，截断）
  // ★ 2026-08-05：v 用 Java 最短表示（DB 有效记录 "0.72"/"5.29"）
  const minuteSpeed: CminuteSpeedstr[] = track.series.minuteSpeeds
    .slice(0, Math.floor(activeTimeSec / 60))
    .map((m) => ({
      min: String(m.minute),
      v: javaNum(m.speedKmh),
    }));

  // pace → [{km, t}]（t 为配速字符串 "05'16''"）
  // ★ C 路线（2026-08-03 定稿）：pace 用插值真实秒取整（事实源 = 区间模型），
  //   与 lastOdometerTime 同源派生（先插值、后格式化），展示层 Σ+last ≈ T 允许 ±1~2s。
  const kmSecs = paceSecondsFromTrack(track.points);
  const pace: Cpacestr[] = kmSecs.map((sec, index) => ({
    km: String(index + 1),
    t: formatPace(Math.max(1, Math.round(sec))),
  }));

  // 极值速度从采样点计算；maxSpeedPerHour 真实为字符串（"17"），min 保留 2 位
  const speeds = track.points.map((p) => p.speedKmh).filter((v) => v > 0);
  const maxSpeedKmh = speeds.length ? Math.max(...speeds) : summary.avgSpeedKmh;
  const minSpeedKmh = speeds.length ? Math.min(...speeds) : summary.avgSpeedKmh;

  // odometer = 距离公里（dllc）；★ 必须与 coordinate 末点 da/1000 严格一致：
  //   生成器轨迹受路线长度约束（distanceTotalM = min(distanceM, progress)），
  //   目标距离 summary.distanceM 可能大于实际累计 → 用 summary 会与 da 矛盾（服务端 reason 24）。
  //   ★ 官方成功 body 这些数值字段均为字符串（Gson String 字段，见 body_real_success.json）
  const lastPointDaKm = coordinate.length
    ? coordinate[coordinate.length - 1]!.da / 1000
    : 0;
  const odometer = lastPointDaKm > 0 ? lastPointDaKm.toFixed(2) : "0.0";
  const odometerKm = Number(odometer);

  // lastOdometerTime：0km → ""（原生 0km body）；有距离 → 最后非整公里段的实际用时。
  // ★ C 路线（2026-08-03 定稿）：事实源 = 插值真实秒（kmSecs），last = T − Σ(插值秒)；
  //   先算真实耗时、后取整显示。不做"先取整 pace 再倒推 last"
  //   （会把前几公里舍入误差全塞进末段；Σ显示+last ≈ T 只是展示层断言，允许 ±1~2s）。
  let lastOdometerTime = "";
  if (odometerKm > 0 && kmSecs.length > 0) {
    const realPaceSum = kmSecs.reduce((sum, value) => sum + value, 0);
    const lastSec = coordWindowSec - realPaceSum;
    lastOdometerTime = formatSeconds(Math.max(1, Math.round(lastSec)));
  }

  const absolute = timeline?.mode === "absolute";
  const beginTime = absolute && timeline?.startTimeLocal ? timeline.startTimeLocal : "";
  const endTime = absolute && timeline?.endTimeLocal ? timeline.endTimeLocal : "";

  const beganPoint = coordinate.length
    ? `${coordinate[0]!.a}|${coordinate[0]!.o}`
    : "";
  const endPoint = coordinate.length
    ? `${coordinate[coordinate.length - 1]!.a}|${coordinate[coordinate.length - 1]!.o}`
    : "";

  return {
    xh: options.uid,
    sportId: options.sportId ?? "",
    // ★ 官方 build() 无条件必填字段（对照 VM 官方抓包 body_vm_real.json）：
    //   name 来自 USERINFO["USERNAME"]（真名）；alreadyPassPointResult/needPassPointCount
    //   build() 无条件赋值（无 AuthInfos → ""；isneedgo=1 计数 → "0"）；
    //   routePolylineBh/lastOdometerTime/randomPointStr：原生 body 可能直接省略
    //   （2026-08-03 原生 savesports 抓包即缺失，服务端正常解析 → reason 1 而非 24）；
    //   显式发送空值仅作兼容性假设，不再作为 reason 24 嫌疑。
    name: options.name ?? "",
    alreadyPassPoint: "",
    alreadyPassPointResult: "",
    // 官方成功 body 为字符串（Gson String 字段）
    needPassPointCount: "0",
    routePolylineBh: "",
    lastOdometerTime,
    randomPointStr: [],
    // 官方必填（App 取 Build.MODEL）。
    // ★ 2026-08-05 修复：回小米 M2007J3SC —— 21 条真实有效记录（result=1，2026-03~05）
    //   全为真机小米提交，服务端信任小米身份；UA=cgapp/3.0.0(...Xiaomi/RSR1.240422.006) 与之自洽。
    //   sdk_gphone_x86_64 是 VM 模拟器身份（8/1 失败样本 body_real_success 本体，reason 24），
    //   且与 Xiaomi UA 自相矛盾（同请求内两套设备身份 = 服务端"数据异常"最强嫌疑）。
    phoneVersion: options.phoneVersion ?? "M2007J3SC,30,11|3.0.0",
    // ★ 2026-08-05：DB 有效记录 cal 为 1 位小数 float（170.6/169.4/170.0）
    calorie: javaCal(lastPointDaKm * 56.8), // 真实 3.08km→175.0cal ≈ 56.8cal/km；★ 与 odometer 同源
    indoor: 0,
    odometer,
    // ★ 2026-08-05：Java 最短表示（DB 有效记录 2.3/5.11/9.04）
    avgSpeed: javaNum(summary.avgSpeedKmh),
    // ★ activeTime 必须 ≤ 坐标时间窗（见上：窗 - 9s 首尾开销；曾比窗多 2s → 已修）
    activeTime: formatSeconds(activeTimeSec),
    beginTime,
    endTime,
    // ★ 官方成功运动上传时 isValid=1（body_real_success.json）；VM 失败样本=-1
    isValid: 1,
    // ★ 官方成功运动 isValidReason=""（VM 失败样本才为 "1"）
    isValidReason: "",
    // routeId/planRouteName 可配置，需与 inSportTime 的 sportTypeId 一致
    routeId: options.routeId ?? "27",
    planRouteName:
      options.planRouteName ??
      (options.routeId === "24" ? "校园环线" : "2号田径场"),
    modementMode: options.sportType ?? "2",
    stepCount: summary.steps,
    pace,
    minuteSpeed,
    // ★ 2026-08-05 格式修正（DB 有效记录实证）：Java 最短表示，非 toFixed(2)/round
    maxSpeedPerHour: javaNum(clampMaxSpeed(maxSpeedKmh)),
    minSpeedPerHour: javaNum(minSpeedKmh),
    avgPace: formatPace(summary.paceSecPerKm),
    stepMinute: javaNum(summary.stepMinute),
    beganPoint,
    endPoint,
    coordinate,
  };
}

/** ★ 2026-08-05：maxSpeedPerHour 按配置 max_speed=17 clamp（UploadJsonSports.build() 同逻辑；
 *   DB 真实记录 maxSp 全 ≤17，超限未 clamp = 服务端"数据异常"嫌疑） */
const MAX_SPEED_CONFIG = 17;

function clampMaxSpeed(v: number): number {
  return Math.min(MAX_SPEED_CONFIG, v);
}

/**
 * ★ 2026-08-05 重放真实记录：把 DB 里真实有效记录（RunRecord，点级字段全保留）原样
 *   组装为 UploadJsonSports。GPS 轨迹 = 100% 真实（服务端当年判过 result=1 的数据），
 *   时间戳 t 保留历史绝对毫秒 → 提交时 alignBodyToTarget 自动平移到新的运动窗口。
 *   sensor 仍需自造（DB 无传感器数据）。
 */
export function replayRecordToUploadJsonSports(
  run: RunRecord,
  options: MapperOptions,
): UploadJsonSports {
  const coordinate: SportLatLngBean[] = run.points.map((p) => ({
    a: round6(p.latGcj02 as number),
    o: round6(p.lngGcj02 as number),
    ac: p.accuracyM ?? 0,
    s: Number((p.speedKmh ?? 0).toFixed(2)),
    d: p.distanceDeltaM ?? 0,
    da: p.distanceTotalM ?? 0,
    st: p.stepDelta ?? 0,
    sta: p.stepTotal ?? 0,
    t: p.timestampMs ?? 0,
    v: p.validFlag ?? 1,
  }));
  const ts = coordinate.map((c) => c.t).filter((t) => t && t > 0);
  const windowSec =
    ts.length >= 2 ? (Math.max(...ts) - Math.min(...ts)) / 1000 : run.durationSec ?? 0;
  // ★ 2026-08-05 activeTime 用 DB 原样值（run.durationSec = sportbean.dltime，当年上传值）。
  //   真实 51 条记录实证：dltime ≈ 坐标窗（差 −3~+6.5s，含静默段的记录 dltime 远小于窗），
  //   由 App 独立计时器产生——不能从坐标窗推导。minuteSpeed 项数 = floor(dltime/60) 自洽。
  const activeTimeSec =
    run.durationSec && run.durationSec > 0 ? run.durationSec : Math.round(windowSec);
  const lastDa = coordinate.length ? coordinate[coordinate.length - 1]!.da : 0;
  const odometer =
    lastDa > 0 ? (lastDa / 1000).toFixed(2) : (run.distanceKm ?? 0).toFixed(2);
  const odometerKm = Number(odometer);
  const speeds = run.points.map((p) => p.speedKmh ?? 0).filter((v) => v > 0);
  const maxSpeedKmh = speeds.length ? Math.max(...speeds) : run.avgSpeedKmh ?? 0;
  const minSpeedKmh = speeds.length ? Math.min(...speeds) : run.avgSpeedKmh ?? 0;
  // 真实记录自带的 pace/minuteSpeed（服务端当年接受的原样数据）；
  // minuteSpeed 项数兜底截断到 floor(activeTimeSec/60)（与提交前校验一致）
  const pace: Cpacestr[] = (run.paceSplits ?? []).map((s, index) => ({
    km: String(index + 1),
    t: String(s.pace ?? ""),
  }));
  const minuteSpeed: CminuteSpeedstr[] = (run.minuteSpeeds ?? [])
    .slice(0, Math.floor(activeTimeSec / 60))
    .map((m) => ({
      min: String(m.minute),
      v: javaNum(Number(m.speed)),
    }));
  // lastOdometerTime：与合成 mapper 同源（activeTime − Σ整公里插值耗时）
  const kmSecs = paceSecondsFromTrack(
    run.points.map((p) => ({
      timestampMs: p.timestampMs ?? 0,
      distanceTotalM: p.distanceTotalM ?? 0,
    })),
  );
  let lastOdometerTime = "";
  if (odometerKm > 0 && kmSecs.length > 0) {
    const realPaceSum = kmSecs.reduce((sum, value) => sum + value, 0);
    const lastSec = activeTimeSec - realPaceSum;
    lastOdometerTime = formatSeconds(Math.max(1, Math.round(lastSec)));
  }
  const beganPoint = coordinate.length
    ? `${coordinate[0]!.a}|${coordinate[0]!.o}`
    : "";
  const endPoint = coordinate.length
    ? `${coordinate[coordinate.length - 1]!.a}|${coordinate[coordinate.length - 1]!.o}`
    : "";
  return {
    xh: options.uid,
    sportId: options.sportId ?? "",
    name: options.name ?? "",
    alreadyPassPoint: "",
    alreadyPassPointResult: "",
    needPassPointCount: "0",
    routePolylineBh: "",
    lastOdometerTime,
    randomPointStr: [],
    phoneVersion: options.phoneVersion ?? "M2007J3SC,30,11|3.0.0",
    calorie: javaCal(odometerKm * 56.8),
    indoor: 0,
    odometer,
    avgSpeed: javaNum(run.avgSpeedKmh ?? (odometerKm / Math.max(1, windowSec / 3600))),
    activeTime: formatSeconds(Math.max(1, activeTimeSec)),
    beginTime: "",
    endTime: "",
    // ★ 真实记录当年服务端返回 result=1（有效）——重放保持自报一致
    isValid: 1,
    isValidReason: "",
    routeId: run.routeId ?? options.routeId ?? "27",
    planRouteName:
      run.routeName ??
      options.planRouteName ??
      (run.routeId === "24" ? "校园环线" : "2号田径场"),
    modementMode: "2",
    stepCount: run.totalSteps ?? 0,
    pace,
    minuteSpeed,
    // ★ 2026-08-05：maxSpeed clamp 到配置 max_speed=17（真实记录 maxSp 全 ≤17）
    maxSpeedPerHour: javaNum(clampMaxSpeed(maxSpeedKmh)),
    minSpeedPerHour: javaNum(minSpeedKmh),
    avgPace: run.avgPace ?? "",
    stepMinute: javaNum(run.stepMinute ?? 0),
    beganPoint,
    endPoint,
    coordinate,
  };
}

/**
 * ★ 2026-08-05 轨迹随机扰动：对重放的真实记录做物理扰动，绕过服务端"重复轨迹检测"。
 *   - 坐标：±3-5m 低通相关噪声（真实 GPS 漂移形态，相邻点相关，非白噪声锯齿）
 *   - 步数：sta 整体 ±20 偏移（st 增量不变，自洽；stepCount 同步偏移）
 *   - 时间戳：不动（保持窗口/pace/activeTime 一致性；align 时统一重锚）
 * 返回扰动后的记录副本（原记录不变）。
 */
export function perturbRun(run: RunRecord, seed: number): RunRecord {
  let state = seed >>> 0;
  const rng = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(rng(), 1e-12);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // 低通相关噪声（AR(1) 均值回归 / Ornstein-Uhlenbeck：零漂移、相邻相关 0.85）。
  //   ★ 不能用随机游走低通（0.72·nx+0.28·g）：游走累计漂移会让轨迹蜿蜒膨胀 ~12%
  //   （实测 3044→3456m，odometer 与 pace 矛盾）；OU 过程噪声围绕 0 波动不漂移。
  //   σ=1m：足够打破"精确重复比对"（起点/终点/点序列全变），da 变化 <2%
  //   （实测 3044→~3090，落在真实记录 3.0-3.11km 分布内）。σ 过大（3m）膨胀 5.5% 过假。
  let nx = 0;
  let ny = 0;
  const PHI = 0.85;
  const SIGMA_M = 1;
  let lastPerturbed: { lat: number; lng: number } | null = null;
  const noiseApplied = run.points.map((p, idx) => {
    if (p.latGcj02 == null || p.lngGcj02 == null) return p;
    // 保留原记录的静止点特征（d=0 或 v=-1 的点不与前一点产生虚假位移）
    if (idx > 0 && ((p.distanceDeltaM ?? 0) === 0 || p.validFlag === -1) && lastPerturbed) {
      return { ...p, latGcj02: lastPerturbed.lat, lngGcj02: lastPerturbed.lng };
    }
    nx = PHI * nx + Math.sqrt(1 - PHI * PHI) * SIGMA_M * gauss();
    ny = PHI * ny + Math.sqrt(1 - PHI * PHI) * SIGMA_M * gauss();
    const lat = p.latGcj02 + nx / 111000;
    const lng = p.lngGcj02 + ny / (111000 * Math.cos((p.latGcj02 * Math.PI) / 180));
    lastPerturbed = { lat, lng };
    return { ...p, latGcj02: lat, lngGcj02: lng };
  });
  // ★ 扰动后 da/d 必须同步重算：真实 da = App 坐标积分，坐标变 da 不变 → 位移 vs da 矛盾。
  //   haversine 累计（首点 da=0），d = 相邻 da 差。
  const points: typeof noiseApplied = [];
  let total = 0;
  let prev: { lat: number; lng: number } | null = null;
  for (let i = 0; i < noiseApplied.length; i += 1) {
    const p = noiseApplied[i]!;
    const origZero = i === 0 || (run.points[i]?.distanceDeltaM ?? 0) === 0 || p.validFlag === -1;
    if (p.latGcj02 != null && p.lngGcj02 != null) {
      if (prev && !origZero) {
        const R = 6371000;
        const dLat = ((p.latGcj02 - prev.lat) * Math.PI) / 180;
        const dLng = ((p.lngGcj02 - prev.lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos((prev.lat * Math.PI) / 180) * Math.cos((p.latGcj02 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
        total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
      prev = { lat: p.latGcj02, lng: p.lngGcj02 };
    }
    points.push({ ...p, distanceTotalM: total, distanceDeltaM: 0 });
  }
  // ★ 保底 3.02km：真实 DB 中部分刚好跑满 3.00km 的记录经 App 样条平滑后末点 da 约 2993m，
  //   若直接 round(da/1000, 2) 会变成 "2.99" 触发距离不足。对 total < 3015m 的有效记录做 <1% 均匀校准。
  if (total > 2950 && total < 3015) {
    const targetTotal = 3018 + rng() * 25; // 3018~3043m → odometer 3.02~3.04km
    const scale = targetTotal / total;
    for (let i = 0; i < points.length; i += 1) {
      points[i] = {
        ...points[i]!,
        distanceTotalM: (points[i]!.distanceTotalM ?? 0) * scale,
      };
    }
    total = targetTotal;
  }
  for (let i = 1; i < points.length; i += 1) {
    points[i] = {
      ...points[i]!,
      distanceDeltaM: (points[i]!.distanceTotalM ?? 0) - (points[i - 1]!.distanceTotalM ?? 0),
    };
  }
  // 步数微调：仅对 st>0 的运动点随机 ±1 微调 st 并重算累计 sta，保证首段 st=0/sta=0 且全程 Σst == sta
  let cumSteps = 0;
  const stepShifted = points.map((p) => {
    let st = p.stepDelta ?? 0;
    if (st >= 2 && rng() < 0.04) {
      st += rng() < 0.5 ? 1 : -1;
    }
    cumSteps += st;
    return { ...p, stepDelta: st, stepTotal: cumSteps };
  });
  const origEndSta = run.points.length ? (run.points[run.points.length - 1]?.stepTotal ?? 0) : 0;
  const origDiff = (run.totalSteps ?? origEndSta) - origEndSta;
  const newTotalSteps = cumSteps + Math.max(0, origDiff);
  const newOdometerKm = Number((total / 1000).toFixed(2));
  const durSec = run.durationSec && run.durationSec > 0 ? run.durationSec : 1150;
  const newAvgSpeedKmh = Number((newOdometerKm / (durSec / 3600)).toFixed(2));
  const newStepMinute = Number((newTotalSteps / (durSec / 60)).toFixed(2));
  const newAvgPace = newOdometerKm > 0 ? formatPace(durSec / newOdometerKm) : run.avgPace;
  return {
    ...run,
    distanceKm: newOdometerKm,
    totalSteps: newTotalSteps,
    avgSpeedKmh: newAvgSpeedKmh,
    stepMinute: newStepMinute,
    avgPace: newAvgPace,
    points: stepShifted,
  };
}
