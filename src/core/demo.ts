import { randomUUID } from 'node:crypto';
import type { RunRecord } from '../track/types.js';
import { identity, newAccount, type Account, type Language, type Library } from './model.js';
import type { Store } from '../runtime/storage.js';

let currentDemoLang: Language = 'zh';
export function setDemoLanguage(lang: Language) {
  currentDemoLang = lang;
}

export const demoSecret = Buffer.alloc(52, 7).toString('base64');
export function demoRun(routeId = '27'): RunRecord {
  const base = 1700000000000;
  return {
    id: 1, sportId: 'demo-source', routeId,
    routeName: currentDemoLang === 'en' ? `Demo Route ${routeId}` : `演示路线 ${routeId}`,
    startDate: null, endDate: null, distanceKm: 3.03, durationSec: 1200, totalSteps: 1803,
    avgSpeedKmh: 9.09, avgPace: "06'36''", stepMinute: 90.15, statusEvidence: {},
    paceSplits: [1, 2, 3].map(km => ({ km, pace: "06'36''" })),
    minuteSpeeds: Array.from({ length: 20 }, (_, i) => ({ minute: i + 1, speed: 9.09 })),
    points: Array.from({ length: 602 }, (_, i) => {
      const angle = i / 601 * Math.PI * 8;
      return {
        id: i, latGcj02: 30 + Math.sin(angle) * 0.0011, lngGcj02: 103 + Math.cos(angle) * 0.00127,
        timestampMs: i === 0 ? 0 : base + i * 2000, accuracyM: i === 0 ? 0 : 5,
        distanceDeltaM: i === 0 ? 0 : 3030 / 601, distanceTotalM: i * 3030 / 601,
        speedKmh: i === 0 ? 0 : 9.09, stepDelta: i === 0 ? 0 : 3, stepTotal: i * 3,
        validFlag: i === 0 ? 0 : 1, usable: i !== 0,
      };
    }),
  };
}
export function demoSession(a: Account) {
  return {
    id: randomUUID(), token: 'demo.payload.signature', secret: demoSecret,
    loginOutTime: '1900000000000', xh: a.username, name: '', gender: '1', identity: identity(a),
    createdAt: Date.now(), status: 'saved' as const,
  };
}
/** 完全内存响应：演示模式无论如何操作都不会调用真实 fetch。 */
export const demoFetch: typeof fetch = async (input, init) => {
  const en = currentDemoLang === 'en';
  const parsedUrl = new URL(String(input)), path = parsedUrl.pathname;
  const ok = (data: unknown) => Response.json({ code: 200, message: 'demo', data }, { headers: { Date: new Date().toUTCString() } });
  if (path.endsWith('/version')) return ok('当前已是最新版本');
  if (path.endsWith('/school')) return ok([
    { id: 99, cnName: '演示大学', enName: 'Demo University', code: 'DEMO', provinceCode: '00', randomCode: '00', serverUrl: 'https://cgapp.chingo.cn/cgapp-server/' },
    { id: 1, cnName: '示例理工学院', enName: 'Sample Institute of Technology', code: 'SIT', provinceCode: '00', randomCode: '01', serverUrl: 'https://cgapp.chingo.cn/cgapp-server/' },
  ]);
  if (path.endsWith('/login')) {
    const username = new URLSearchParams(String(init?.body)).get('username');
    return ok({ token: `demo.payload.signature.${demoSecret}.1900000000000`, info: { xh: username, xb: '1' } });
  }
  if (path.endsWith('/issue')) return ok(`demo.payload.signature.${demoSecret}.1900000000000`);
  if (path.endsWith('/currentTimeMillis')) return ok(String(Date.now() + 36));
  if (path.endsWith('/termlist')) return ok(en ? [
    { id: 18, name: '2026–2027 Autumn Semester', stadate: '2026-08-26 00:00:00', enddate: '2027-01-22 23:59:59', isCurrentTerm: true },
    { id: 17, name: '2025–2026 Spring Semester', stadate: '2026-03-01 00:00:00', enddate: '2026-07-11 23:59:59', isCurrentTerm: false },
  ] : [
    { id: 18, name: '2026-2027学年第一学期', stadate: '2026-08-26 00:00:00', enddate: '2027-01-22 23:59:59', isCurrentTerm: true },
    { id: 17, name: '2025-2026学年第二学期', stadate: '2026-03-01 00:00:00', enddate: '2026-07-11 23:59:59', isCurrentTerm: false },
  ]);
  if (path.endsWith('/termSportTotal')) return ok(en
    ? { datas: [{ des: 'Valid Runs', value: '12', unit: 'runs' }, { des: 'Events', value: '0', unit: 'pts' }], tips: 'Credited sessions for current term' }
    : { datas: [{ des: '跑步次数', value: '12', unit: '次' }, { des: '项目次数', value: '0', unit: '次' }], tips: '本学期纳入考核的数据' });
  if (path.endsWith('/statistics')) return ok({ totalExerciseCount: 12, avgOdometer: '12.12', avgExerciseTime: '01:18:00', avgExerciseCount: 4, countArr: [9.09, 12.12, 15.15], maxExercise: 15.15 });
  if (path.endsWith('/sporttype')) return ok(en ? [
    { id: 27, sportName: 'Track Sector #2', vdistance: 3, minVtime: '00:02:00', maxVtime: '02:00:00', isUseSensor: 0, isRandomWayPoint: 1, vcount: 5, latlng: '29.998,102.998;29.998,103.002;30.002,103.002;30.002,102.998', tips: 'Valid when distance >= 3.0 km and duration <= 120 min' },
    { id: 24, sportName: 'Campus Loop', vdistance: 3, minVtime: '00:02:00', maxVtime: '02:00:00', isUseSensor: 1, isRandomWayPoint: 1, latlng: '29.995,102.995;29.995,103.005;30.005,103.005;30.005,102.995', tips: 'Valid when distance >= 3.0 km and duration <= 120 min' },
  ] : [
    { id: 27, sportName: '2号田径场', vdistance: 3, minVtime: '00:02:00', maxVtime: '02:00:00', isUseSensor: 0, isRandomWayPoint: 1, vcount: 5, latlng: '29.998,102.998;29.998,103.002;30.002,103.002;30.002,102.998', tips: '运动距离大于3公里且时间小于120分钟有效' },
    { id: 24, sportName: '校园环线', vdistance: 3, minVtime: '00:02:00', maxVtime: '02:00:00', isUseSensor: 1, isRandomWayPoint: 1, latlng: '29.995,102.995;29.995,103.005;30.005,103.005;30.005,102.995', tips: '运动距离大于3公里且时间小于120分钟有效' },
  ]);
  if (path.endsWith('/invalidconf')) return ok(en
    ? [{ code: '1', reason: 'Below Target Distance', reasonDes: 'Recorded distance did not meet the route threshold.' }, { code: '4', reason: 'Outside Permitted Window', reasonDes: 'Session fell outside active venue hours.' }]
    : [{ code: '1', reason: '未达到指定公里数', reasonDes: '距离不满足学校规定。' }, { code: '4', reason: '不在指定运动时段内', reasonDes: '运动时间不满足学校规定。' }]);
  if (path.endsWith('/activity')) return ok(en ? [
    {
      orderid: 191,
      createDate: '2026-09-02 10:12:27',
      isForcedRemind: '1',
      isShowInHome: '1',
      remindStartTime: '2026-09-02 08:00',
      remindEndTime: '2026-12-30 22:00',
      subContent: 'Schedule outdoor conditioning runs within permitted hours and observe track safety guidelines.',
      title: '2026–2027 Autumn Term Extracurricular Conditioning Guidelines',
      url: 'http://cgapp.chingo.cn/cgapp-server/activity/detail/191',
    },
    {
      orderid: 190,
      createDate: '2026-09-15 17:34:04',
      isForcedRemind: '0',
      isShowInHome: '1',
      remindStartTime: '',
      remindEndTime: '',
      subContent: '',
      title: 'Annual Physical Fitness Assessment Schedule',
      url: 'https://portal.campus.example.edu/notice/10479.htm',
    },
  ] : [
    {
      orderid: 191,
      createDate: '2026-09-02 10:12:27',
      isForcedRemind: '1',
      isShowInHome: '1',
      remindStartTime: '2026-09-02 08:00',
      remindEndTime: '2026-12-30 22:00',
      subContent: '请按本学期公共体育课实施细则合理安排长跑锻炼时段，注意运动安全。',
      title: '2026-2027学年秋季学期公共体育课课外锻炼通知',
      url: 'http://cgapp.chingo.cn/cgapp-server/activity/detail/191',
    },
    {
      orderid: 190,
      createDate: '2026-09-15 17:34:04',
      isForcedRemind: '0',
      isShowInHome: '1',
      remindStartTime: '',
      remindEndTime: '',
      subContent: '',
      title: '关于开展本学年学生体质健康测试工作的通知',
      url: 'https://portal.campus.example.edu/notice/10479.htm',
    },
  ]);
  if (path.endsWith('/notifications')) return ok(en ? [
    { title: 'Track Sector #2 Evening Lighting & Hours Update', url: 'http://cgapp.chingo.cn/cgapp-server/activity/detail/192' },
  ] : [
    { title: '2号运动场开放时段调整提醒', url: 'http://cgapp.chingo.cn/cgapp-server/activity/detail/192' },
  ]);
  if (path.includes('/activity/detail/')) {
    return new Response(
      en
        ? '<html><body><h3>Conditioning Notice Detail</h3><p>1. Each valid outdoor session requires at least 3.0 km within the prescribed pace envelope.</p><p>2. Check campus bulletins during severe weather or track maintenance.</p></body></html>'
        : '<html><body><h3>学校课外锻炼通知详情</h3><p>1. 本学期阳光长跑有效单次距离不少于 3.0 公里，配速需处于学校规定区间。</p><p>2. 遇极端降雨或场地维护，请留意最新公告安排。</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
  if (path.endsWith('/sport/detail')) {
    const coords = Array.from({ length: 461 }, (_, i) => {
      const ang = (i / 460) * Math.PI * 6;
      return {
        a: +(30 + Math.sin(ang) * 0.00108 + Math.sin(ang * 3) * 0.00004).toFixed(6),
        o: +(103 + Math.cos(ang) * 0.00126 + Math.cos(ang * 2) * 0.00003).toFixed(6),
        s: +(8.8 + Math.sin(i * 0.09) * 0.7).toFixed(2),
        v: 1,
      };
    });
    return ok({ coordinatestr: JSON.stringify(coords), routepolylinelist: [{}], minuteSpeedStr: Array.from({ length: 15 }, () => ({})), sensorFile: '' });
  }
  if (path.endsWith('/sportlist')) {
    if (parsedUrl.searchParams.get('type') === '0') {
      return ok([{
        sportId: 'demo-archive-record', routeId: '27',
        tableName: '202502', beginTime: '2026-05-18 19:12:00', endTime: '2026-05-18 19:31:40',
        odometer: '3.12', activeTime: '00:19:40', isValid: '1', checkStatus: '1', isValidReason: '',
      }]);
    }
    return ok([{
      sportId: 'demo-record', routeId: '27',
      tableName: '202601', beginTime: '2026-10-31 18:00:00', endTime: '2026-10-31 18:20:00',
      odometer: '3.03', activeTime: '00:20:00', isValid: '1', checkStatus: '1', isValidReason: '',
    }]);
  }
  if (path.endsWith('/inSportTime')) return ok('1');
  if (path.endsWith('/sportsId')) return ok(`demo-${randomUUID()}`);
  if (path.endsWith('/prejudgment')) return ok([]);
  if (path.endsWith('/savesports')) return ok({ sportId: 'demo-saved', isValid: '1', checkStatus: '1', inValidReason: '' });
  if (path.endsWith('/sensorZipFile')) return ok('1');
  throw new Error('Unexpected demo endpoint');
};
export async function seedDemo(store: Store, lang: Language = 'zh') {
  currentDemoLang = lang;
  if (lang === 'en') store.state.settings.language = 'en';
  const a = newAccount(lang === 'en' ? 'NEON-01' : '我的账号', 'demo0016', 'demo-school');
  const b = newAccount(lang === 'en' ? 'MIRAGE-02' : '第二账号', 'demo0002', 'demo-school');
  a.session = demoSession(a); b.session = demoSession(b);
  store.state.accounts.push(a, b);
  for (const scope of ['private', 'public'] as const) {
    const label = lang === 'en'
      ? (scope === 'private' ? 'Personal Telemetry · Demo' : 'Shared Pool · Demo')
      : (scope === 'private' ? '我的真机记录 · 演示' : '本机共享 · 演示');
    const l: Library = {
      id: randomUUID(), label,
      scope, ...(scope === 'private' ? { ownerAccountId: a.id } : {}), runCount: 2, routeIds: ['24', '27'], importedAt: Date.now(),
    };
    store.state.libraries.push(l);
    await store.putLibrary(l.id, { runs: [demoRun('27'), { ...demoRun('24'), id: 2 }], sensors: {} });
  }
}
