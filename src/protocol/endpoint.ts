/**
 * 端点常量与已知 Header 元数据。
 *
 * 来源：`Retrofit_ApiInterface_C0395.java`（端点路径）、
 * `NativeToken_C0265.java`（签名路径提取规则）、`BaseUrl_C0254.java`（baseUrl 选择）、
 * `Retrofit_Client_C0279.java`（app-key 条件逻辑）。
 */

export type HttpMethod = "GET" | "POST";

export interface EndpointDef {
  /** 端点标识 */
  key: string;
  method: HttpMethod;
  /** 相对路径（baseUrl 之后的部分） */
  path: string;
  /** 是否 FormUrlEncoded 且含 jsonsports 字段 */
  jsonsports: boolean;
  /** 服务端响应 data 类型 */
  responseKind: "SportResult" | "String" | "Object";
  /** 对应 Retrofit 混淆接口方法名，便于回溯 */
  sourceMethod: string;
}

/** 普通运动上传：POST api/l/v7/savesports，@Field("jsonsports")，返回 ApiResult<SportResult> */
export const saveSports: EndpointDef = {
  key: "saveSports",
  method: "POST",
  path: "api/l/v7/savesports",
  jsonsports: true,
  responseKind: "SportResult",
  sourceMethod: "m3721",
};

/** 分钟运动上传：POST api/l/v6/sportMinute/save，@Field("jsonsports")，返回 ApiResult<Object> */
export const saveMinuteSport: EndpointDef = {
  key: "saveMinuteSport",
  method: "POST",
  path: "api/l/v6/sportMinute/save",
  jsonsports: true,
  responseKind: "Object",
  sourceMethod: "m3733",
};

/**
 * 预判接口：POST api/l/v6.1/prejudgment，@Field("jsonsports")。
 * 抓包证实（2026-08-03 cap 4191 行）：真实客户端在运动结束时、savesports 之前先调用，
 * 载荷为同一 sportId 下的"结束时刻快照"（无 coordinate、stepCount 未定格、
 * minuteSpeed 含 baseObjId）；数秒后 savesports 才提交定格后的完整记录。
 * ⚠️ HTTP 形态（method/URL/body 位置）待 SSL 报文第二阶段确认，此定义仅登记路径。
 */
export const prejudgment: EndpointDef = {
  key: "prejudgment",
  method: "POST",
  path: "api/l/v6.1/prejudgment",
  jsonsports: true,
  responseKind: "Object",
  sourceMethod: "prejudgment",
};

/** 获取 sportId：GET api/l/v7/sportsId，返回 ApiResult<String> */
export const sportsId: EndpointDef = {
  key: "sportsId",
  method: "GET",
  path: "api/l/v7/sportsId",
  jsonsports: false,
  responseKind: "String",
  sourceMethod: "m3737",
};

/**
 * 运动开始时间上报：GET api/l/v6.1/sporttype/inSportTime?sportTypeId=<id>
 * 协议行为：客户端在开始运动时先调用本接口，
 * 服务端记录"运动开始"状态（到达时刻 = 运动开始时刻），随后才 GET sportsId。
 * ★ 2026-08-05 实测：GET → 200；POST → 405（请求方式不支持）。method 是 GET！
 * ★ 直连提交跳过 inSportTime → 服务端无运动开始记录 → savesports 判 reason 24。必调。
 */
export const inSportTime: EndpointDef = {
  key: "inSportTime",
  method: "GET",
  path: "api/l/v6.1/sporttype/inSportTime",
  jsonsports: false,
  responseKind: "Object",
  sourceMethod: "inSportTime",
};

/** 运动列表/状态查询：GET api/l/v6/activity?page=-1（返回 ApiResult<List>） */
export const activityList: EndpointDef = {
  key: "activityList",
  method: "GET",
  path: "api/l/v6/activity?page=-1",
  jsonsports: false,
  responseKind: "Object",
  sourceMethod: "activity?page=-1",
};

/** 陀螺仪/传感器 zip 上传：POST api/l/v7/upload/sensorZipFile */
export const uploadSensorZip: EndpointDef = {
  key: "uploadSensorZip",
  method: "POST",
  path: "api/l/v7/upload/sensorZipFile",
  jsonsports: false,
  responseKind: "String",
  sourceMethod: "m3705",
};

/** 传感器文件上传（gyro 备用分支）：POST api/l/v7/upload/sensorFile */
export const uploadSensorFile: EndpointDef = {
  key: "uploadSensorFile",
  method: "POST",
  path: "api/l/v7/upload/sensorFile",
  jsonsports: false,
  responseKind: "String",
  sourceMethod: "m3726",
};

/** 端点注册表（按 key 索引；推荐直接用上面的命名导出以保留具体类型） */
export const ENDPOINTS = {
  saveSports,
  saveMinuteSport,
  prejudgment,
  sportsId,
  inSportTime,
  uploadSensorZip,
  uploadSensorFile,
} as const satisfies Record<string, EndpointDef>;

/** baseUrl 选择：默认生产 + XJTU 特例（BaseUrl_C0254.m3206/m3207） */
export const BASE_URLS = {
  default: "https://tyapp.chingo.cn/cgapp/",
  /** 非 XJTU 时的 server-url 默认值 */
  defaultServer: "http://cgsoft.appdemo.chingo.cn/cgapp-server/",
  xjtuServer: "http://ggtypt.xjtu.edu.cn/cgapp-server/",
  xjtuWeb: "http://ggtypt.xjtu.edu.cn/cgapp/",
} as const;

/**
 * 提取用于签名的路径（NativeToken_C0265.m3227）。
 * 规则：URL 含 "/app" 则从 /app 起取；否则从 /api 起取。
 * 例：https://tyapp.chingo.cn/cgapp/api/l/v7/savesports → "/api/l/v7/savesports"
 */
export function extractSignPath(url: string): string {
  const appIndex = url.indexOf("/app");
  const apiIndex = url.indexOf("/api");
  if (appIndex !== -1 && (apiIndex === -1 || appIndex < apiIndex)) {
    return url.slice(appIndex);
  }
  if (apiIndex !== -1) {
    return url.slice(apiIndex);
  }
  return url;
}

/**
 * app-key 条件选择（Retrofit_Client_C0279.m3256）：
 * baseUrl 含 "cgapp-server" → C0373.m3457()，否则 C0373.m3450()。
 * 此处返回元数据而非真实值（真实值依赖未还原的 R.string 与 C0367 计算）。
 */
export function appKeyNeeded(baseUrl: string): boolean {
  return baseUrl.includes("cgapp-server");
}
