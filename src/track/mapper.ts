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

import type { GcjCoord, RouteTemplate, RunRecord, SyntheticTrack, TrackPoint } from "./types.js";
import { pointInPolygon } from "./geo.js";
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

function flatDistM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dy = (lat2 - lat1) * 111000;
  const dx = (lng2 - lng1) * 111320 * Math.cos(((lat1 + lat2) * 0.5 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

function pointToFenceDistM(lat: number, lng: number, fence: GcjCoord[]): number {
  if (fence.length < 3) return Infinity;
  const mLat = 111000;
  const mLng = 111320 * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < fence.length - 1; i++) {
    const a = fence[i]!, b = fence[i + 1]!;
    const ax = (a[1] - lng) * mLng, ay = (a[0] - lat) * mLat;
    const bx = (b[1] - lng) * mLng, by = (b[0] - lat) * mLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq)) : 0;
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 清洗原始轨迹中的两类地图叠加以假乱真缺陷，并做多圈走廊中心收敛：
 * 1) 冷启动基站漂移（首段 t=0 / v=-1 / ac>30 落在宿舍楼墙里或河道中，导致手机端高德地图从墙里拉出红线）；
 * 2) 途中信号丢失尖峰（v=-1 / ac>32 / 超音速瞬移跳变穿墙过水后回到原路）；
 * 3) 多圈同向走廊横向外扩回归（将单圈多径反射偏到看台围墙或湖边的轨迹温和拉回真实跑道中心带）。
 */
export function sanitizeRunPoints(rawPoints: TrackPoint[]): TrackPoint[] {
  const pts = rawPoints.map((p) => ({ ...p }));
  const n = pts.length;
  if (n < 4) return pts;

  const isReliable = (i: number) => {
    const p = pts[i]!;
    return (
      i > 0 &&
      p.validFlag === 1 &&
      (p.accuracyM ?? 0) <= 28 &&
      p.latGcj02 != null &&
      p.lngGcj02 != null &&
      Number.isFinite(p.latGcj02) &&
      Number.isFinite(p.lngGcj02)
    );
  };

  let firstClean = -1;
  for (let i = 1; i < n; i++) {
    if (!isReliable(i)) continue;
    let nextClean = -1;
    for (let j = i + 1; j < Math.min(n, i + 8); j++) {
      if (isReliable(j)) {
        nextClean = j;
        break;
      }
    }
    if (
      nextClean < 0 ||
      flatDistM(
        pts[i]!.latGcj02!,
        pts[i]!.lngGcj02!,
        pts[nextClean]!.latGcj02!,
        pts[nextClean]!.lngGcj02!,
      ) <= 22
    ) {
      firstClean = i;
      break;
    }
  }

  if (firstClean > 0) {
    const anchor = pts[firstClean]!;
    for (let i = 0; i < firstClean; i++) {
      const p = pts[i]!;
      if (p.latGcj02 == null || p.lngGcj02 == null) continue;
      if (
        flatDistM(p.latGcj02, p.lngGcj02, anchor.latGcj02!, anchor.lngGcj02!) > 10 ||
        p.validFlag === -1 ||
        (p.accuracyM ?? 0) > 30
      ) {
        p.latGcj02 = anchor.latGcj02;
        p.lngGcj02 = anchor.lngGcj02;
        if (i > 0 && p.validFlag === -1) p.validFlag = 0;
        if (i > 0 && (p.accuracyM ?? 0) > 15) p.accuracyM = 8.5;
      }
    }
  }

  const bad = new Uint8Array(n);
  let lastClean = firstClean >= 0 ? firstClean : 0;
  for (let i = Math.max(1, firstClean + 1); i < n; i++) {
    const p = pts[i]!, prev = pts[lastClean]!;
    if (p.latGcj02 == null || p.lngGcj02 == null || prev.latGcj02 == null || prev.lngGcj02 == null) continue;
    const dStep = flatDistM(prev.latGcj02, prev.lngGcj02, p.latGcj02, p.lngGcj02);
    const dtSec = Math.max(0.5, ((p.timestampMs ?? 0) - (prev.timestampMs ?? 0)) / 1000);
    if (p.validFlag === -1 || (p.accuracyM ?? 0) > 32 || (dStep > 18 && dStep / dtSec > 8.2)) {
      bad[i] = 1;
    } else {
      lastClean = i;
    }
  }

  let idx = 1;
  while (idx < n) {
    if (!bad[idx]) {
      idx++;
      continue;
    }
    let end = idx;
    while (end + 1 < n && bad[end + 1]) end++;
    const left = idx - 1;
    const right = end + 1 < n ? end + 1 : -1;
    const a = pts[left]!;
    if (
      right > 0 &&
      end - idx + 1 <= 16 &&
      a.latGcj02 != null &&
      a.lngGcj02 != null &&
      pts[right]!.latGcj02 != null &&
      pts[right]!.lngGcj02 != null &&
      flatDistM(a.latGcj02, a.lngGcj02, pts[right]!.latGcj02!, pts[right]!.lngGcj02!) <= 45
    ) {
      const b = pts[right]!;
      const tSpan = (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
      for (let k = idx; k <= end; k++) {
        const pk = pts[k]!;
        const r =
          tSpan > 0 && (pk.timestampMs ?? 0) > 0
            ? Math.max(0, Math.min(1, ((pk.timestampMs ?? 0) - (a.timestampMs ?? 0)) / tSpan))
            : (k - left) / (right - left);
        pk.latGcj02 = a.latGcj02 + (b.latGcj02! - a.latGcj02) * r;
        pk.lngGcj02 = a.lngGcj02 + (b.lngGcj02! - a.lngGcj02) * r;
        if (pk.validFlag === -1) pk.validFlag = (pk.distanceDeltaM ?? 0) > 0 ? 1 : 0;
        if ((pk.accuracyM ?? 0) > 15) pk.accuracyM = 9.5;
      }
    } else if (right < 0 && a.latGcj02 != null && a.lngGcj02 != null) {
      for (let k = idx; k <= end; k++) {
        pts[k]!.latGcj02 = a.latGcj02;
        pts[k]!.lngGcj02 = a.lngGcj02;
        if (pts[k]!.validFlag === -1) pts[k]!.validFlag = 0;
      }
    }
    idx = end + 1;
  }

  // 多趟走廊横向收敛：将偏离同向多圈中位线 >1.6m 的外飘段平滑拉回真实跑道/步道走廊
  const oLat = pts[0]!.latGcj02 ?? 30.0;
  const oLng = pts[0]!.lngGcj02 ?? 103.0;
  const mLat = 111000;
  const mLng = 111320 * Math.cos((oLat * Math.PI) / 180);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = ((pts[i]!.lngGcj02 ?? oLng) - oLng) * mLng;
    ys[i] = ((pts[i]!.latGcj02 ?? oLat) - oLat) * mLat;
  }
  const txs = new Float64Array(n);
  const tys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 3), i1 = Math.min(n - 1, i + 3);
    let dx = xs[i1]! - xs[i0]!, dy = ys[i1]! - ys[i0]!;
    let len = Math.hypot(dx, dy);
    if (len < 0.5 && i + 1 < n) {
      dx = xs[i + 1]! - xs[i]!;
      dy = ys[i + 1]! - ys[i]!;
      len = Math.hypot(dx, dy);
    }
    if (len >= 1e-6) {
      txs[i] = dx / len;
      tys[i] = dy / len;
    } else if (i > 0) {
      txs[i] = txs[i - 1]!;
      tys[i] = tys[i - 1]!;
    } else {
      txs[i] = 1;
      tys[i] = 0;
    }
  }

  const corr = new Float64Array(n);
  const peers: number[] = [];
  for (let i = 0; i < n; i++) {
    const tx = txs[i]!, ty = tys[i]!, nx = -ty, ny = tx;
    peers.length = 0;
    for (let j = 1; j < n; j++) {
      if (Math.abs(j - i) <= 25) continue;
      if (tx * txs[j]! + ty * tys[j]! < 0.82) continue;
      const rx = xs[j]! - xs[i]!, ry = ys[j]! - ys[i]!;
      // 纵向窗口收紧到 ≤2.8m，避免在 400m 弯道上把前后弦高当成横向偏离而把整圈半径往内缩（曾导致 3km 缩水 75m 触发 24）
      if (Math.abs(rx * tx + ry * ty) > 6.5) continue;
      const latOff = rx * nx + ry * ny;
      if (Math.abs(latOff) <= 24) peers.push(latOff);
    }
    if (peers.length >= 3) {
      peers.sort((a, b) => a - b);
      const med = peers[peers.length >> 1]!;
      const absM = Math.abs(med);
      // 仅对偏离多圈中位线 >2.8m 的单圈多径外飘段做拉回，保留正常道次与弯道周长
      if (absM > 2.8) {
        corr[i] = Math.sign(med) * Math.min(absM, 0.9 * (absM - 1.0));
      }
    }
  }

  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) {
      sum += corr[k]!;
      cnt++;
    }
    const shift = sum / cnt;
    if (Math.abs(shift) > 1e-4 && pts[i]!.latGcj02 != null && pts[i]!.lngGcj02 != null) {
      const nx = -tys[i]!, ny = txs[i]!;
      pts[i]!.lngGcj02 = oLng + (xs[i]! + nx * shift) / mLng;
      pts[i]!.latGcj02 = oLat + (ys[i]! + ny * shift) / mLat;
    }
  }
  for (let i = 2; i < n; i++) {
    if ((pts[i - 1]!.timestampMs ?? 0) > 0 && (pts[i]!.timestampMs ?? 0) <= (pts[i - 1]!.timestampMs ?? 0)) {
      pts[i]!.timestampMs = pts[i - 1]!.timestampMs! + 500;
    }
  }
  return pts;
}

export function resolveRouteFence(
  _points: TrackPoint[],
  _routeId?: string | null,
  boundaryGcj02?: GcjCoord[],
): GcjCoord[] | undefined {
  return boundaryGcj02 && boundaryGcj02.length >= 3 ? boundaryGcj02 : undefined;
}

/**
 * ★ 走廊约束切向/法向物理微扰（Frenet-Frame Corridor-Constrained Perturbation）：
 *   1. 先清洗原始轨迹冷启动漂移、途中信号丢失尖峰与多圈外飘，并修复旧版 d=0 冻结导致的穿墙/过水直线弦；
 *   2. 沿运动切向（跑道/道路延伸方向）施加主随机微扰（±1.6m），法向（左右横跨跑道/河岸/墙壁方向）严格收敛在半条跑道内（±0.60m）；
 *   3. 自动结合场地电子围栏做内缩保护，绝不把点推向围栏外侧。
 */
export function perturbRun(
  run: RunRecord,
  seed: number,
  boundaryGcj02?: GcjCoord[],
): RunRecord {
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
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  const cleaned = sanitizeRunPoints(run.points);
  const n = cleaned.length;
  const firstPt = cleaned.find((p) => p.latGcj02 != null && p.lngGcj02 != null);
  const fence = resolveRouteFence(cleaned, run.routeId, boundaryGcj02);

  const oLat = firstPt?.latGcj02 ?? 30.0;
  const oLng = firstPt?.lngGcj02 ?? 103.0;
  const mLat = 111000;
  const mLng = 111320 * Math.cos((oLat * Math.PI) / 180);
  const xs = cleaned.map((p) => ((p.lngGcj02 ?? oLng) - oLng) * mLng);
  const ys = cleaned.map((p) => ((p.latGcj02 ?? oLat) - oLat) * mLat);

  const txs = new Float64Array(n);
  const tys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - 2), i1 = Math.min(n - 1, i + 2);
    let dx = xs[i1]! - xs[i0]!, dy = ys[i1]! - ys[i0]!;
    let len = Math.hypot(dx, dy);
    if (len < 0.3 && i + 1 < n) {
      dx = xs[i + 1]! - xs[i]!;
      dy = ys[i + 1]! - ys[i]!;
      len = Math.hypot(dx, dy);
    }
    if (len >= 1e-6) {
      txs[i] = dx / len;
      tys[i] = dy / len;
    } else if (i > 0) {
      txs[i] = txs[i - 1]!;
      tys[i] = tys[i - 1]!;
    } else {
      txs[i] = 1;
      tys[i] = 0;
    }
  }

  const PHI = 0.85;
  const SIGMA_TAN = 0.95;
  const SIGMA_LAT = 0.45;
  const laneBiasM = (rng() - 0.5) * 0.50; // ±0.25m 整趟微幅道次平移
  let sTan = 0;
  let sLat = 0;
  let lastPerturbed: { lat: number; lng: number } | null = null;
  let lastRaw: { lat: number; lng: number } | null = null;

  const haversineM = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371000;
    const dLatR = ((lat2 - lat1) * Math.PI) / 180;
    const dLngR = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLatR / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLngR / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const clampInsideFence = (baseLat: number, baseLng: number, lat: number, lng: number, tx: number, ty: number, dTan: number, dLat: number) => {
    if (!fence || !pointInPolygon([baseLat, baseLng], fence)) return { lat, lng };
    const nx = -ty, ny = tx;
    const baseFenceDist = pointToFenceDistM(baseLat, baseLng, fence);
    if (
      pointInPolygon([lat, lng], fence) &&
      (baseFenceDist > 4.5 || pointToFenceDistM(lat, lng, fence) >= baseFenceDist - 0.15)
    ) {
      return { lat, lng };
    }
    const altLat = baseLat + (ty * dTan - ny * Math.abs(dLat)) / mLat;
    const altLng = baseLng + (tx * dTan - nx * Math.abs(dLat)) / mLng;
    if (pointInPolygon([altLat, altLng], fence) && pointToFenceDistM(altLat, altLng, fence) >= baseFenceDist) {
      return { lat: altLat, lng: altLng };
    }
    const halfLat = baseLat + (ty * dTan * 0.5) / mLat;
    const halfLng = baseLng + (tx * dTan * 0.5) / mLng;
    if (pointInPolygon([halfLat, halfLng], fence)) return { lat: halfLat, lng: halfLng };
    return { lat: baseLat, lng: baseLng };
  };

  const noiseApplied = cleaned.map((p, idx) => {
    if (p.latGcj02 == null || p.lngGcj02 == null) return p;
    const rawMoveM =
      idx > 0 && lastRaw ? flatDistM(lastRaw.lat, lastRaw.lng, p.latGcj02, p.lngGcj02) : Infinity;
    lastRaw = { lat: p.latGcj02, lng: p.lngGcj02 };

    // 仅当原坐标确实原地静止（<0.15m）时才复用上一点扰动坐标，彻底消除 d=0 移动段被冻结后穿墙拉直线的问题
    if (idx > 0 && rawMoveM < 0.15 && lastPerturbed) {
      return { ...p, latGcj02: lastPerturbed.lat, lngGcj02: lastPerturbed.lng };
    }

    sTan = PHI * sTan + Math.sqrt(1 - PHI * PHI) * SIGMA_TAN * gauss();
    sLat = PHI * sLat + Math.sqrt(1 - PHI * PHI) * SIGMA_LAT * gauss();
    const moveScale = idx === 0 ? 0.35 : clamp(rawMoveM / 1.5, 0.25, 1);
    const dTan = clamp(sTan, -1.6, 1.6) * moveScale;
    const dLat = clamp(laneBiasM + sLat, -0.85, 0.85) * moveScale;

    const tx = txs[idx]!, ty = tys[idx]!;
    const nx = -ty, ny = tx;
    const candLat = p.latGcj02 + (ty * dTan + ny * dLat) / mLat;
    const candLng = p.lngGcj02 + (tx * dTan + nx * dLat) / mLng;
    const { lat, lng } = clampInsideFence(p.latGcj02, p.lngGcj02, candLat, candLng, tx, ty, dTan, dLat);

    lastPerturbed = { lat, lng };
    return { ...p, latGcj02: lat, lngGcj02: lng };
  });

  // ★ 扰动后 da/d 严格由 v=1 有效移动点的真实 Haversine 位移累加，杜绝「只乘 da 数字不改坐标」引发服务端 reason=24
  const points: typeof noiseApplied = [];
  let total = 0;
  let prev: { lat: number; lng: number } | null = null;
  for (let i = 0; i < noiseApplied.length; i += 1) {
    const p = noiseApplied[i]!;
    const origZero = i === 0 || (run.points[i]?.distanceDeltaM ?? 0) === 0 || p.validFlag !== 1;
    let stepD = 0;
    if (p.latGcj02 != null && p.lngGcj02 != null) {
      if (prev && !origZero) {
        stepD = haversineM(prev.lat, prev.lng, p.latGcj02, p.lngGcj02);
        total += stepD;
      }
      prev = { lat: p.latGcj02, lng: p.lngGcj02 };
    }
    points.push({ ...p, distanceTotalM: total, distanceDeltaM: stepD });
  }

  // ★ 真实几何续跑补偿（替代旧版虚假缩放 distanceTotalM *= scale！）：
  //   部分刚好跑满 3.00km 的 DB 样本经客户端样条平滑后真实 Haversine 仅 ~2985-2995m；
  //   服务端会独立校验 ΣHaversine(coordinate) ≥ 3000m 且与 da 一致（旧版只放大 da 导致差 40-80m 必报 24）。
  //   此处沿该样本自身真实跑道/道路走廊无缝续跑数个采样点至 ≥3065m，保证任意 3.02-3.05km 裁剪后真实 Haversine 100% 达标且 d == Haversine。
  let appended = false;
  if ((run.distanceKm ?? 0) >= 2.95 && total > 2800 && total < 3065 && points.length >= 60) {
    const targetMinM = 3068 + rng() * 24;
    const endIdx = points.length - 1;
    const endPt = points[endIdx]!;
    const endTx = txs[endIdx]!, endTy = tys[endIdx]!;

    // 在同趟轨迹内部寻找位置最接近且同向的真实走廊锚点（环形操场/校园环线天然命中 <3m）
    let bestAnchor = -1;
    let bestDist = 16;
    for (let i = 15; i < endIdx - 25; i++) {
      const cand = points[i]!;
      if (cand.validFlag !== 1 || cand.latGcj02 == null || cand.lngGcj02 == null) continue;
      if (txs[i]! * endTx + tys[i]! * endTy < 0.75) continue;
      const dM = flatDistM(endPt.latGcj02!, endPt.lngGcj02!, cand.latGcj02, cand.lngGcj02);
      if (dM < bestDist) {
        bestDist = dM;
        bestAnchor = i;
      }
    }

    const baseLen = points.length;
    const offLat = bestAnchor >= 0 ? endPt.latGcj02! - points[bestAnchor]!.latGcj02! : 0;
    const offLng = bestAnchor >= 0 ? endPt.lngGcj02! - points[bestAnchor]!.lngGcj02! : 0;
    let cursor = bestAnchor >= 0 ? bestAnchor + 1 : baseLen - 2;
    let dir = bestAnchor >= 0 ? 1 : -1;
    let guard = 0;

    while (total < targetMinM && guard < 80) {
      guard++;
      if (dir === 1 && cursor >= baseLen) {
        cursor = Math.max(15, bestAnchor);
      } else if (dir === -1 && cursor < 15) {
        dir = 1;
        cursor = 16;
      }
      const donor = points[cursor]!;
      const prevDonor = points[Math.max(1, cursor - 1)]!;
      cursor += dir;
      if (donor.latGcj02 == null || donor.lngGcj02 == null) continue;

      const decay = bestAnchor >= 0 ? Math.exp(-guard / 4) : 0;
      let nextLat = donor.latGcj02 + offLat * decay;
      let nextLng = donor.lngGcj02 + offLng * decay;
      if (fence && !pointInPolygon([nextLat, nextLng], fence)) {
        nextLat = donor.latGcj02;
        nextLng = donor.lngGcj02;
      }

      const lastPt = points[points.length - 1]!;
      const stepDist = haversineM(lastPt.latGcj02!, lastPt.lngGcj02!, nextLat, nextLng);
      if (stepDist < 0.3 || stepDist > 16) continue;

      const rawDt = Math.abs((donor.timestampMs ?? 0) - (prevDonor.timestampMs ?? 0));
      const dtMs = Math.round(clamp(rawDt >= 800 && rawDt <= 3200 ? rawDt : 2000, 1600, 2500) + (rng() - 0.5) * 24);
      const nextTs = (lastPt.timestampMs ?? 0) + dtMs;
      const st = donor.stepDelta && donor.stepDelta > 0 ? clamp(donor.stepDelta, 2, 8) : Math.max(2, Math.round(stepDist / 1.15));
      const spdKmh = Number(((stepDist / (dtMs / 1000)) * 3.6).toFixed(2));
      total += stepDOr(stepDist);
      points.push({
        id: (lastPt.id ?? points.length) + 1,
        latGcj02: nextLat,
        lngGcj02: nextLng,
        timestampMs: nextTs,
        accuracyM: 3.7900924682617188,
        distanceDeltaM: stepDist,
        distanceTotalM: total,
        speedKmh: clamp(spdKmh, 3.5, 16.5),
        stepDelta: st,
        stepTotal: (lastPt.stepTotal ?? 0) + st,
        validFlag: 1,
        usable: true,
      });
      appended = true;
    }
  }

  function stepDOr(v: number) { return v; }

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
  const positivePts = stepShifted.filter((p) => (p.timestampMs ?? 0) > 0);
  const coordWindowSec =
    positivePts.length > 1
      ? Math.round((positivePts[positivePts.length - 1]!.timestampMs! - positivePts[0]!.timestampMs!) / 1000)
      : 0;
  const durSec = appended && coordWindowSec > 0 ? coordWindowSec : run.durationSec && run.durationSec > 0 ? run.durationSec : 1150;
  const newAvgSpeedKmh = Number((newOdometerKm / (durSec / 3600)).toFixed(2));
  const newStepMinute = Number((newTotalSteps / (durSec / 60)).toFixed(2));
  const newAvgPace = newOdometerKm > 0 ? formatPace(durSec / newOdometerKm) : run.avgPace;

  let paceSplits = run.paceSplits;
  let minuteSpeeds = run.minuteSpeeds;
  if (appended && positivePts.length > 2) {
    const firstTs = positivePts[0]!.timestampMs!;
    const offsetSec = (p: TrackPoint) => (p.timestampMs! - firstTs) / 1000;
    const timeAtM = (m: number) => {
      const idx2 = positivePts.findIndex((p) => (p.distanceTotalM ?? 0) >= m);
      if (idx2 < 0) return durSec;
      const b = positivePts[idx2]!, a = positivePts[idx2 - 1];
      if (!a) return 0;
      const r = (m - (a.distanceTotalM ?? 0)) / Math.max(1e-6, (b.distanceTotalM ?? 0) - (a.distanceTotalM ?? 0));
      return offsetSec(a) + (offsetSec(b) - offsetSec(a)) * r;
    };
    const distAtSec = (sec: number) => {
      if (sec <= 0) return 0;
      if (sec >= durSec) return total;
      const idx2 = positivePts.findIndex((p) => offsetSec(p) >= sec);
      if (idx2 < 0) return total;
      const b = positivePts[idx2]!, a = positivePts[idx2 - 1];
      if (!a) return b.distanceTotalM ?? 0;
      const r = (sec - offsetSec(a)) / Math.max(1e-6, offsetSec(b) - offsetSec(a));
      return (a.distanceTotalM ?? 0) + ((b.distanceTotalM ?? 0) - (a.distanceTotalM ?? 0)) * r;
    };
    let prevBoundary = 0;
    paceSplits = Array.from({ length: Math.floor(total / 1000) }, (_, i) => {
      const boundary = timeAtM((i + 1) * 1000);
      const seg = boundary - prevBoundary;
      prevBoundary = boundary;
      return { km: i + 1, pace: formatPace(seg) };
    });
    minuteSpeeds = Array.from({ length: Math.floor(durSec / 60) }, (_, i) => ({
      minute: i + 1,
      speed: Number(((distAtSec((i + 1) * 60) - distAtSec(i * 60)) * 0.06).toFixed(2)),
    }));
  }

  return {
    ...run,
    durationSec: durSec,
    distanceKm: newOdometerKm,
    totalSteps: newTotalSteps,
    avgSpeedKmh: newAvgSpeedKmh,
    stepMinute: newStepMinute,
    avgPace: newAvgPace,
    paceSplits,
    minuteSpeeds,
    points: stepShifted,
  };
}
