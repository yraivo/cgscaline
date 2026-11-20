/**
 * 协议层类型定义。
 *
 * JSON 键名 = Java 字段名（Gson 无 @SerializedName，直接使用字段名）。
 * 坐标系 GCJ-02。
 */

/** 轨迹点（SportLatLngBean / slllist 元素）——真实字段名。
 * 对应（SportLatLngBean.toSportLatlng()）：a=纬度, o=经度, ac=精度, s=速度,
 * d=段距离, da=累计距离, st=段步数, sta=累计步数, t=epoch ms, v=有效标志(-1/0/1)。
 */
export interface SportLatLngBean {
  /** 纬度 latitude */
  a: number;
  /** 经度 longitude */
  o: number;
  /** 精度 accuracy */
  ac: number;
  /** 速度 speed */
  s: number;
  /** 上一段距离 lastDistance */
  d: number;
  /** 累计距离 totalDistance */
  da: number;
  /** 上一段步数 lastStep */
  st: number;
  /** 累计步数 totalStep */
  sta: number;
  /** 时间戳 epoch ms */
  t: number;
  /** 有效标志 status：1=有效, 0=可用性差, -1=GPS 丢失 */
  v: number;
}

/** 分钟速度序列元素（CminuteSpeedstr：min + v，sportId 为 transient 不序列化） */
export interface CminuteSpeedstr {
  /** 分钟序号 */
  min: string;
  /** 该分钟速度 km/h */
  v: string;
}

/** 配速序列元素（Cpacestr：km + t，其余字段 transient 不序列化） */
export interface Cpacestr {
  /** 公里序号 */
  km: string;
  /** 该公里配速，格式 "05'16''" */
  t: string;
}

/**
 * 普通运动记录实体（net.crigh.cgsport.model.SportBean）。
 * 字段名与 JSON 键一一对应；status/gyroUploadStatus/result/checkStatus/isValidReason
 * 五个字段构成上传成功判定（见 writeback.ts）。
 */
export interface SportBean {
  activityStatus: number;
  alreadyPassPoint?: string;
  avgPace?: string;
  avgSpeed?: string;
  cal: number;
  checkResult?: string;
  checkStatus: string;
  considerStatus?: string;
  distance: number;
  dlTime?: string;
  dllc?: string;
  endDate: string;
  endDateLong: number;
  gyroUploadStatus: number;
  hasPhoto?: number;
  id: number;
  imageItems?: unknown[];
  images?: string;
  indoor?: number;
  isValidReason: string;
  lastOdometerTime?: string;
  maxSpeedPerHour?: string;
  minSpeedPerHour?: string;
  minuteSpeedStr?: CminuteSpeedstr[];
  name?: string;
  paceStr?: Cpacestr[];
  resourceType?: string;
  result: number;
  routeId?: string;
  routeName?: string;
  routePolylineBh?: string;
  slllist?: SportLatLngBean[];
  sportId: string;
  sportType: string;
  startDate: string;
  startDateLong: number;
  status: number;
  stepMinute?: string;
  tableName?: string;
  tip?: string;
  totalStep: number;
  uid: string;
  validCount?: number;
  validOdometer?: number;
}

/** 分钟运动实体（net.crigh.cgsport.MinuteSportEntity）——成功判定字段 */
export interface MinuteSportEntity {
  _id: number;
  activeTime?: string;
  activityStatus: string;
  avgPace?: string;
  avgSpeed?: string;
  beganPoint?: string;
  beginTime?: string;
  calorie?: string;
  coordinate?: unknown[];
  currentDate?: string;
  endPoint?: string;
  endTime?: string;
  id: number;
  isCommitData: boolean;
  lastOdometerTime?: string;
  maxSpeed?: string;
  maxSpeedPerHour?: string;
  minSpeedPerHour?: string;
  minuteSpeed?: unknown[];
  modementMode?: string;
  name?: string;
  needUpdate?: string;
  odometer?: string;
  pace?: unknown[];
  phoneVersion?: string;
  planRouteName?: string;
  routeId?: string;
  sportId?: string;
  stepCount?: string;
  stepMinute?: string;
  xh?: string;
}

/** 服务端响应包装（net.crigh.library.model.ApiResult<T>），code==200 为成功 */
export interface ApiResult<T> {
  code: number;
  data: T | null;
  message: string;
}

/**
 * 服务端运动上传结果（net.crigh.cgsport.model.SportResult）。
 * 客户端回写：sportId→setSportId, inValidReason→setIsValidReason,
 * isValid→setResult(parseInt), checkStatus→setCheckStatus, tip→setTip。
 */
export interface SportResult {
  checkStatus: string;
  inValidReason: string;
  /** "1"=有效 */
  isValid: string;
  sportId: string;
  tip: string;
}

/**
 * 真正上传的 JSON 结构（UploadJsonSports.java，Gson 序列化后）。
 * 不是 SportBean！字段名以本类为准。transient 字段由 Gson 默认排除。
 */
export interface UploadJsonSports {
  /** 学号 */
  xh: string;
  sportId: string;
  /** 手机型号（C0431.m3831） */
  phoneVersion?: string;
  name?: string;
  calorie: number;
  indoor: number;
  /** 距离公里（dllc 或末点 da/1000）——官方成功 body 为字符串（Gson String 字段） */
  odometer: string;
  avgSpeed: string;
  /** 运动时长 "HH:mm:ss" */
  activeTime: string;
  beginTime: string;
  endTime: string;
  isValid: number;
  isValidReason: string;
  alreadyPassPoint?: string;
  alreadyPassPointResult?: string;
  needPassPointCount?: string;
  routeId?: string;
  planRouteName?: string;
  routePolylineBh?: string;
  /** 运动类型（sportBean.getSportType） */
  modementMode: string;
  stepCount: number;
  pace?: Cpacestr[];
  minuteSpeed?: CminuteSpeedstr[];
  maxSpeedPerHour: string;
  minSpeedPerHour: string;
  avgPace: string;
  lastOdometerTime?: string;
  stepMinute: string;
  /** 首/末点 "a|o" */
  beganPoint?: string;
  endPoint?: string;
  coordinate?: SportLatLngBean[];
  sportImages?: string;
  randomPointStr?: Array<{ id: number; latlng: string }>;
}

/** 请求头集合（对应 NativeToken_C0265 拦截器注入的 header） */
export interface CgSportHeaders {
  "Content-Type": string;
  imei: string;
  v1: string;
  timestamp: string;
  sign: string;
  cgAuthorization: string;
  "User-Agent": string;
  client: string;
  /** 仅 cgapp-server 系列 baseUrl 需要；值来自 C0373.m3457()/m3450() */
  "app-key"?: string;
}

/** 一条完整的上传请求（client 构造、mock server 打印） */
export interface PreparedRequest {
  method: string;
  /** 完整 URL（baseUrl + path） */
  url: string;
  headers: CgSportHeaders;
  /** 供 fetch 使用的扁平 headers（同 headers，但类型满足 HeadersInit） */
  fetchHeaders: Record<string, string>;
  /** 原始 JSON 明文（上传链的第一段） */
  jsonBody: string;
  /** body 编码后的值，作为表单字段 jsonsports 提交 */
  jsonsports: string;
}
