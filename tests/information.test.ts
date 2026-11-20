import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/runtime/storage.js';
import {Engine} from '../src/runtime/engine.js';
import {demoFetch,seedDemo} from '../src/core/demo.js';
import {deviceHeaders} from '../src/core/model.js';
import {chinaDateMs,readInformationEndpoint} from '../src/campus/information.js';
import {detailLines,informationLines,schoolLines} from '../src/ui/information-view.js';

async function fixture(override?:typeof fetch){
  const store=new Store(null);await seedDemo(store);
  const calls:Array<{url:URL;method:string;headers:Headers}>=[];
  const fetcher:typeof fetch=async(input,init)=>{calls.push({url:new URL(String(input)),method:init?.method??'GET',headers:new Headers(init?.headers)});return(override??demoFetch)(input,init);};
  const engine=new Engine(store,fetcher);await engine.initialize();await engine.checkSchool();calls.length=0;
  return{store,engine,calls,a:store.state.accounts[0]!,b:store.state.accounts[1]!};
}
test('账号概览四个 GET 与学校资料两个 GET 分开读取，保留学期边界和动态单位',async()=>{
  const{engine,a,calls}=await fixture();const info=await engine.information(a.id,true);
  assert.equal(calls.length,4);assert.ok(calls.every(c=>c.method==='GET'));
  assert.ok(calls.every(c=>c.headers.get('cgAuthorization')===a.session!.token&&c.headers.get('imei')===deviceHeaders(a.device).imei));
  assert.ok(calls.every(c=>!!c.headers.get('sign')&&!!c.headers.get('timestamp')&&!!c.headers.get('client')));
  const stats=calls.find(c=>c.url.pathname.endsWith('/statistics'))!.url;
  assert.equal(stats.searchParams.get('xh'),a.username);assert.equal(stats.searchParams.get('validStatus'),'1');assert.equal(stats.searchParams.get('type'),'TERM');
  assert.equal(new Date(Number(stats.searchParams.get('endTime'))).toISOString(),'2027-01-22T15:59:59.000Z');
  assert.equal(info.statistics.data!.count,12);assert.equal(info.totals.data![0]!.unit,'次');assert.equal(info.rules.data,undefined);
  const school=await engine.schoolInformation(a.id,true);assert.equal(calls.length,6);
  assert.equal(calls.find(c=>c.url.pathname.endsWith('/sporttype'))!.url.searchParams.get('uid'),a.username);assert.equal(school.rules.data![0]!.minDuration,'00:02:00');
  assert.ok(Number.isFinite(info.clock.data!.offsetMs));
  const saved=JSON.stringify(info);for(const credential of[a.session!.token,a.session!.secret])assert.equal(saved.includes(credential),false);
  assert.match(informationLines(a).join('\n'),/月均有效里程/);assert.match(schoolLines(a).join('\n'),/单次时长/);
  assert.equal(schoolLines(a).join('\n').includes('开放时段'),false);
});
test('概览缓存随加密档案状态保存；重开不联网，手动刷新冷却，账号缓存独立',async()=>{
  const{store,engine,a,b,calls}=await fixture();const info=await engine.information(a.id,true);
  await engine.information(a.id);assert.equal(calls.length,4);
  await assert.rejects(engine.information(a.id,true),/60 秒/);assert.equal(calls.length,4);
  const reopened=new Store(null);reopened.state=structuredClone(store.state);
  let reads=0;const e=new Engine(reopened,async()=>{reads++;throw Error('unexpected network');});await e.initialize();
  assert.equal(reads,0);assert.deepEqual(await e.information(a.id),info);assert.equal(reads,0);
  await assert.rejects(e.information(a.id,true),/60 秒/);assert.equal(reads,0);
  await engine.information(b.id,true);assert.equal(calls.length,8);assert.notEqual(b.information?.identity,info.identity);
});
test('信息查询遇到 2001 或 2003 立即结束批次，不续期、不登录',async()=>{
  for(const code of[2001,2003]){
    const{engine,a,calls}=await fixture(async(input,init)=>String(input).includes('/currentTimeMillis')?Response.json({code,data:null}):demoFetch(input,init));
    const info=await engine.information(a.id,true);assert.equal(calls.length,1);assert.equal(info.clock.code,code);assert.ok(info.rules.error);
    assert.equal(calls.some(c=>/issue|login|sportsId|inSportTime|save/.test(c.url.pathname)),false);
    if(code===2001)assert.equal(a.session!.status,'invalid');
  }
});
test('未知响应只影响对应展示区，不能把布尔值当统计数字',async()=>{
  const{engine,a,calls}=await fixture(async(input,init)=>String(input).includes('/statistics')?Response.json({code:200,data:{totalExerciseCount:false}}):demoFetch(input,init));
  const info=await engine.information(a.id,true);assert.ok(info.statistics.error);assert.equal(info.statistics.data,undefined);assert.ok(info.clock.data);assert.equal(calls.length,4);
});
test('网络中断、非 JSON 或服务限流会停止整批读取，不连续尝试余下接口',async()=>{
  for(const failure of['network','json','limit']){
    const{engine,a,calls}=await fixture(async(input,init)=>{
      if(!String(input).includes('/currentTimeMillis'))return demoFetch(input,init);
      if(failure==='network')throw Error('opaque network failure');
      if(failure==='json')return new Response('unrecognized gateway');
      return Response.json({code:429},{status:429});
    });
    const info=await engine.information(a.id,true);assert.equal(calls.length,1);assert.ok(info.clock.error);assert.ok(info.rules.error);
    assert.equal(a.session!.status,'saved');assert.equal(info.clock.data,undefined);
  }
});
test('检测到更新时不放行信息读取',async()=>{
  const{store,a}=await fixture();store.state.settings.compatibility=undefined;a.compatibility=undefined;
  const urls:string[]=[];const engine=new Engine(store,async input=>{urls.push(String(input));return Response.json({code:200,data:{isForceUpdate:1,content:'new version'}});});
  await assert.rejects(engine.information(a.id,true),/需要更新/);assert.equal(urls.length,1);assert.ok(urls[0]!.includes('/api/version?'));assert.equal(a.information,undefined);
});
test('详情仅能使用当前账号查到的记录；保留 tableName，不能借另一个账号或改返回对象来查询',async()=>{
  const{engine,a,b,calls}=await fixture();
  await assert.rejects(engine.recordDetail(a.id,'foreign-record'),/记录列表/);assert.equal(calls.length,0);
  const rows=await engine.records(a.id);assert.equal(rows[0]!.tableName,'202601');
  await assert.rejects(engine.recordDetail(b.id,rows[0]!.sportId),/记录列表/);
  rows[0]!.sportId='forged-reference';await assert.rejects(engine.recordDetail(a.id,'forged-reference'),/记录列表/);
  assert.equal(calls.length,1);
  const detail=await engine.recordDetail(a.id,'demo-record');const url=calls.at(-1)!.url;
  assert.equal(url.searchParams.get('term'),'202601');assert.equal(url.searchParams.get('sportId'),'demo-record');
  assert.equal(detail.coordinateCount,461);assert.equal(detail.routeCount,1);assert.equal(detail.minuteCount,15);assert.equal(detail.sensorReturned,false);
  const good=await engine.records(a.id);assert.match(detailLines(good[0]!,detail).join('\n'),/轨迹点  461/);
});
test('详情参数与信息接口固定白名单在发送前检查，日期按中国时区解释',async()=>{
  const{a}=await fixture();let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error('unexpected');};
  await assert.rejects(readInformationEndpoint(a,fetcher,'detail',{record:{sportId:'own-record'}}),/学期表/);
  await assert.rejects(readInformationEndpoint(a,fetcher,'savesports' as never),/不支持/);assert.equal(calls,0);
  assert.equal(chinaDateMs('2026-10-31 23:59:59'),Date.parse('2026-10-31T15:59:59Z'));
});

test('记录列表返回防污染缓存，详情重复查看复用摘要；显式刷新重新请求并清理详情缓存',async()=>{
  const{engine,a,b,calls}=await fixture();assert.equal(engine.cachedRecords(a.id),undefined);assert.equal(calls.length,0);
  await engine.records(a.id);const list=engine.cachedRecords(a.id)!;assert.equal(calls.length,1);
  list.records[0]!.sportId='tampered';assert.equal(engine.cachedRecords(a.id)!.records[0]!.sportId,'demo-record');assert.equal(engine.cachedRecords(b.id),undefined);
  const first=await engine.recordDetail(a.id,'demo-record');first.coordinateCount=99999;
  const cached=await engine.recordDetail(a.id,'demo-record');assert.equal(cached.coordinateCount,461);assert.equal(calls.length,2);
  await engine.recordDetail(a.id,'demo-record',true);assert.equal(calls.length,3);
  await engine.records(a.id);await engine.recordDetail(a.id,'demo-record');assert.equal(calls.length,5);
  await engine.configure(a.id,{device:{...a.device,model:'Changed'}});assert.equal(engine.cachedRecords(a.id),undefined);
  await assert.rejects(engine.recordDetail(a.id,'demo-record'),/登录信息已失效/);assert.equal(calls.length,5);
});

test('界面读取列表和指定详情缓存不触发接口，缓存绑定账号和设备，返回值不能污染缓存',async()=>{
  const{engine,a,b,calls}=await fixture();
  assert.equal(await engine.loadCachedRecords(a.id,'demo-record'),undefined);assert.equal(calls.length,0);
  await engine.records(a.id);assert.equal(calls.length,1);
  assert.equal((await engine.loadCachedRecords(a.id,'demo-record'))?.detail,undefined);assert.equal(calls.length,1);
  await engine.recordDetail(a.id,'demo-record',true);assert.equal(calls.length,2);
  const cache=(await engine.loadCachedRecords(a.id,'demo-record'))!;
  assert.equal(cache.detail!.coordinateCount,461);cache.detail!.coordinateCount=99999;cache.records[0]!.sportId='tampered';
  assert.equal((await engine.loadCachedRecords(a.id,'demo-record'))?.detail?.coordinateCount,461);
  assert.equal((await engine.loadCachedRecords(a.id,'demo-record'))?.records[0]!.sportId,'demo-record');
  assert.equal(await engine.loadCachedRecords(b.id,'demo-record'),undefined);
  assert.equal((await engine.loadCachedRecords(a.id,'foreign-record'))?.detail,undefined);
  assert.equal(calls.length,2);
  await engine.configure(a.id,{device:{...a.device,model:'Changed'}});
  assert.equal(await engine.loadCachedRecords(a.id,'demo-record'),undefined);assert.equal(calls.length,2);
});
test('学校页独立缓存与冷却，学校先读取不会伪造个人概览已刷新',async()=>{
  const{store,engine,a,calls}=await fixture();
  const school=await engine.schoolInformation(a.id,true);assert.equal(calls.length,2);assert.equal(school.fetchedAt,0);assert.ok(school.schoolFetchedAt);
  assert.ok(calls[0]!.url.pathname.endsWith('/sporttype'));assert.ok(calls[1]!.url.pathname.endsWith('/invalidconf'));
  await engine.schoolInformation(a.id);assert.equal(calls.length,2);await assert.rejects(engine.schoolInformation(a.id,true),/60 秒/);
  const personal=await engine.information(a.id,true);assert.equal(calls.length,6);assert.ok(personal.fetchedAt);assert.equal(personal.schoolFetchedAt,school.schoolFetchedAt);
  const reopened=new Store(null);reopened.state=structuredClone(store.state);let reads=0;
  const e=new Engine(reopened,async()=>{reads++;throw Error('unexpected');});await e.initialize();await e.schoolInformation(a.id);assert.equal(reads,0);
  await assert.rejects(e.schoolInformation(a.id,true),/60 秒/);assert.equal(reads,0);
});
test('学校资料保持读取账号隔离，认证失效后结束两项读取且不续期',async()=>{
  const{engine,a,b,calls}=await fixture(async(input,init)=>{
    const url=new URL(String(input));if(url.pathname.endsWith('/sporttype'))return Response.json({code:200,data:[{id:'24',sportName:url.searchParams.get('uid')}]});
    return demoFetch(input,init);
  });
  const one=await engine.schoolInformation(a.id,true),two=await engine.schoolInformation(b.id,true);
  assert.equal(one.rules.data![0]!.name,a.username);assert.equal(two.rules.data![0]!.name,b.username);assert.equal(calls.length,4);
  const stopped=await fixture(async(input,init)=>String(input).includes('/sporttype')?Response.json({code:2003}):demoFetch(input,init));
  const info=await stopped.engine.schoolInformation(stopped.a.id,true);assert.equal(stopped.calls.length,1);assert.equal(info.rules.code,2003);assert.ok(info.reasons.error);
});

test('缺失缓存不会隐式联网，过期缓存和重启只读；换身份或会话后拒绝复用',async()=>{
  const{engine,store,a,b,calls}=await fixture();
  await assert.rejects(engine.information(a.id),/按 R 刷新/);await assert.rejects(engine.schoolInformation(a.id),/按 R 刷新/);assert.equal(calls.length,0);
  await engine.information(a.id,true);await engine.schoolInformation(a.id,true);assert.equal(calls.length,6);
  a.information!.fetchedAt=a.information!.schoolFetchedAt=Date.now()-30*24*3600_000;
  const reopened=new Store(null);reopened.state=structuredClone(store.state);let reads=0;
  const e=new Engine(reopened,async()=>{reads++;throw Error('unexpected network');});await e.initialize();
  assert.equal((await e.information(a.id)).fetchedAt,a.information!.fetchedAt);await e.schoolInformation(a.id);assert.equal(reads,0);
  await assert.rejects(e.schoolInformation(b.id),/按 R 刷新/);assert.equal(reads,0);
  const current=e.account(a.id);current.session!.id='different-session';await assert.rejects(e.schoolInformation(a.id),/按 R 刷新/);
  current.session!.id=a.session!.id;current.device.model+='Changed';await assert.rejects(e.information(a.id),/按 R 刷新/);assert.equal(reads,0);
});
