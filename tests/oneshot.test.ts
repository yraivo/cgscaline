import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/runtime/storage.js';
import { Engine } from '../src/runtime/engine.js';
import { demoRun,demoFetch,seedDemo } from '../src/core/demo.js';
import { prepareOneShot,type LibraryData } from '../src/track/library.js';
import { perturbRun,replayRecordToUploadJsonSports } from '../src/track/mapper.js';
import { phoneVersion } from '../src/core/model.js';
import { coordinateWindow,fitRun,parseDistance,parseDuration,durationText } from '../src/track/fit.js';
import { validateSaveJson } from '../src/protocol/validate.js';
import { geometryErrors } from '../src/track/geometry.js';

async function fixture(){
  const store=new Store(null);await seedDemo(store);let requests=0;
  const engine=new Engine(store,async()=>{requests++;throw Error('No network in preview');});await engine.initialize();
  const a=store.state.accounts[0]!,library=store.state.libraries[0]!,data=await store.getLibrary<LibraryData>(library.id);
  data.runs.push({...demoRun(),id:3,sportId:'another-demo-source'});library.runCount=data.runs.length;await store.putLibrary(library.id,data);
  return{store,engine,a,library,data,requests:()=>requests};
}

test('诊断 legacy 模式仍复用旧 mapper 的轨迹与统计字段，元数据明确来源，预览不联网',async()=>{
  const{store,a,library,data,requests}=await fixture(),seed=40731;
  const p=await prepareOneShot(store,a,library.id,{runId:1,seed,mode:'legacy'});
  const expected=replayRecordToUploadJsonSports(perturbRun(data.runs[0]!,seed),{uid:a.username,phoneVersion:phoneVersion(a.device)});
  assert.equal(p.targets,undefined);assert.equal(p.sourceRunId,1);assert.equal(p.sourceDurationSec,1200);
  for(const field of ['pace','minuteSpeed','activeTime','avgPace','odometer','stepCount'] as const)assert.deepEqual(p.body[field],expected[field]);
  assert.deepEqual(p.body.coordinate!.map(({t,...fields})=>fields),expected.coordinate!.map(({t,...fields})=>fields));
  assert.equal(requests(),0);
});

test('换一版保持账号/路线/来源范围，尽可能换来源且一定换种子，原库不变',async()=>{
  const{store,engine,a,library,data,requests}=await fixture(),before=JSON.stringify(data);
  let p=await engine.prepareDefault(a.id);
  for(let i=0;i<8;i++){
    const next=await engine.prepareDefault(a.id,{avoidRunId:p.sourceRunId,avoidSeed:p.seed});
    assert.notEqual(next.seed,p.seed);assert.notEqual(next.sourceRunId,p.sourceRunId);assert.equal(next.candidateCount,2);
    assert.equal(next.body.xh,a.username);assert.equal(next.routeId,a.routeId);assert.equal(next.libraryId,library.id);p=next;
  }
  assert.equal(JSON.stringify(await store.getLibrary(library.id)),before);assert.equal(requests(),0);
});

test('自动模式改变时长与截取距离，和手动模式统一重算统计，R 不固定上次自动目标',async()=>{
  const{store,engine,a,library,requests}=await fixture(),times=new Set<number>(),distances=new Set<string>();
  const before=JSON.stringify(await store.getLibrary(library.id));
  for(let seed=10000;seed<10012;seed++){
    const p=await engine.prepareDefault(a.id,{runId:1,seed});
    assert.equal(p.generation,'auto');assert.equal(p.targets,undefined);assert.ok(p.fit);
    assert.equal(p.sensorSource,'generated');assert.equal(p.sensor.length,p.durationSec*10);
    const ts=p.body.coordinate!.filter(v=>v.t>0).map(v=>v.t);
    assert.equal((Math.max(...ts)-Math.min(...ts))/1000,p.durationSec);
    assert.equal(p.body.activeTime,durationText(p.durationSec));assert.equal(p.body.minuteSpeed!.length,Math.floor(p.durationSec/60));
    assert.equal(p.body.stepCount,p.body.coordinate!.at(-1)!.sta);
    assert.equal(p.body.stepCount,p.body.coordinate!.reduce((n,v)=>n+v.st,0));
    assert.ok(Number(p.body.odometer)>=3.02);assert.ok(Math.abs(p.fit.timeScale-1)<=.061);
    assert.deepEqual(validateSaveJson({...p.body,sportId:'PRECHECK-SID'},{sensorSampleCount:p.sensor.length}),[]);
    times.add(p.durationSec);distances.add(p.body.odometer);
  }
  assert.ok(times.size>5);assert.ok(distances.size>1);assert.equal(requests(),0);
  assert.equal(JSON.stringify(await store.getLibrary(library.id)),before);
});

test('预览定时与并发计划共用生成链路，定时快照不被后续刷新修改，到点才申请 sportId',async()=>{
  const store=new Store(null);await seedDemo(store);const calls:string[]=[];
  const e=new Engine(store,async(input,init)=>{calls.push(new URL(String(input)).pathname.split('/').at(-1)!);return demoFetch(input,init);});
  await e.initialize();const a=store.state.accounts[0]!,p=await e.prepareDefault(a.id,{distanceKm:3.01,durationSec:1140});
  const reviewed=structuredClone(p),task=await e.queuePrepared(a.id,p,Date.now()+60_000);
  assert.equal(task.phase,'queued');assert.equal(calls.length,0);p.body.odometer='99';await e.prepareDefault(a.id);
  assert.deepEqual(task.prepared,reviewed);task.plannedStartAt=Date.now()-1;await e.tick();
  assert.equal(task.phase,'waiting');assert.equal(task.prepared.targets!.distanceKm,3.01);assert.equal(task.prepared.durationSec,1140);
  assert.equal(calls.filter(v=>v==='sportsId').length,1);await e.fastForwardDemo(task.id);assert.equal(task.phase,'done');await e.shutdown();
});

test('目标时长重建时轴、步频、配速、分钟速度与传感器长度，时长精确到秒',async()=>{
  const{store,a,library,data,requests}=await fixture();data.sensors['1']=Array(12000).fill(9.81);await store.putLibrary(library.id,data);
  const p=await prepareOneShot(store,a,library.id,{runId:1,seed:40731,durationSec:1140});
  const ts=p.body.coordinate!.filter(p=>p.t>0).map(p=>p.t);
  assert.equal((Math.max(...ts)-Math.min(...ts))/1000,1140);assert.equal(p.durationSec,1140);assert.equal(p.body.activeTime,'00:19:00');
  assert.equal(p.body.minuteSpeed!.length,19);assert.equal(p.sensor.length,11400);assert.equal(p.sensorSource,'generated');
  assert.equal(p.body.stepCount,p.body.coordinate!.at(-1)!.sta);assert.equal(p.body.stepCount,p.body.coordinate!.reduce((n,p)=>n+p.st,0));
  assert.equal(p.body.stepMinute,String(Number((Number(p.body.stepCount)*60/1140).toFixed(2))));
  assert.ok(Number(p.body.avgSpeed)<=Number(p.body.maxSpeedPerHour));
  for(let i=2;i<p.body.coordinate!.length;i++){
    const point=p.body.coordinate![i]!,previous=p.body.coordinate![i-1]!;
    assert.ok(Math.abs(point.s-point.d/(point.t-previous.t)*3600)<=.0051);
  }
  assert.deepEqual(validateSaveJson({...p.body,sportId:'PRECHECK-SID'},{sensorSampleCount:p.sensor.length}),[]);assert.deepEqual(geometryErrors(p),[]);
  const repeated=await prepareOneShot(store,a,library.id,{runId:1,seed:40731,durationSec:1140});
  assert.deepEqual(repeated.sensor,p.sensor);assert.deepEqual(repeated.body.pace,p.body.pace);assert.deepEqual(repeated.body.minuteSpeed,p.body.minuteSpeed);
  assert.equal(requests(),0);
});

test('目标距离只截取来源前缀并插值末点，不缩放整条轨迹、不外推或加圈',async()=>{
  const{store,a,library,data,requests}=await fixture(),seed=40731;
  const perturbed=perturbRun(data.runs[0]!,seed),fit=fitRun(perturbed,{distanceKm:3.01,durationSec:1140},3.03);
  assert.equal(fit.run.points.at(-1)!.distanceTotalM,3010);assert.ok(fit.run.points.length<perturbed.points.length);
  assert.deepEqual(fit.run.points.slice(0,-1).map(p=>[p.latGcj02,p.lngGcj02]),perturbed.points.slice(0,fit.run.points.length-1).map(p=>[p.latGcj02,p.lngGcj02]));
  assert.equal(coordinateWindow(fit.run),1140);assert.equal(fit.run.minuteSpeeds.length,19);assert.equal(fit.run.paceSplits.length,3);
  const p=await prepareOneShot(store,a,library.id,{runId:1,seed,distanceKm:3.01,durationSec:1140});
  assert.equal(p.body.odometer,'3.01');assert.equal(p.body.coordinate!.at(-1)!.da,3010);assert.equal(p.durationSec,1140);
  assert.deepEqual(p.targets,{distanceKm:3.01,durationSec:1140});assert.deepEqual(validateSaveJson({...p.body,sportId:'PRECHECK-SID'},{sensorSampleCount:p.sensor.length}),[]);
  assert.equal(requests(),0);
});

test('不支持的目标在本地拒绝，不能跨路线/私人库回退，且不修改档案或发请求',async()=>{
  const{store,engine,a,library,requests}=await fixture(),before=JSON.stringify(store.state);
  await assert.rejects(engine.prepareDefault(a.id,{distanceKm:4}),/样本距离不足/);
  await assert.rejects(engine.prepareDefault(a.id,{durationSec:3600}),/超过 15%/);
  await assert.rejects(prepareOneShot(store,store.state.accounts[1]!,library.id,{durationSec:1140}),/不能使用/);
  await assert.rejects(engine.prepareDefault(a.id,{seed:NaN}),/随机种子/);
  await assert.rejects(engine.prepareDefault(a.id,{distanceKm:3.001}),/两位小数/);
  assert.equal(JSON.stringify(store.state),before);assert.equal(requests(),0);
});

test('自定义匹配可使用默认 14–30 分钟偏好池之外的同路线样本',async()=>{
  const{store,a,library,data}=await fixture(),long=demoRun();long.id=5;long.durationSec=2400;
  const first=long.points[1]!.timestampMs!;long.points=long.points.map((p,i)=>({...p,timestampMs:i===0?0:first+(p.timestampMs!-first)*2}));
  data.runs.push(long);await store.putLibrary(library.id,data);
  const p=await prepareOneShot(store,a,library.id,{seed:40731,durationSec:2280});assert.equal(p.sourceRunId,5);assert.equal(p.durationSec,2280);
});

test('目标输入不接受 NaN、负数、异常秒数；时长与配速格式正确进位',()=>{
  assert.equal(parseDuration('15'),900);assert.equal(parseDuration('15:30'),930);assert.equal(parseDuration('00:15:30'),930);
  assert.equal(parseDuration('15.5'),930);assert.equal(parseDuration(''),undefined);assert.equal(parseDistance('3.03'),3.03);assert.equal(parseDistance(''),undefined);
  for(const value of ['NaN','0','-3','15:60','120:10'])assert.throws(()=>parseDuration(value));
  for(const value of ['NaN','-3','3.001','2.99'])assert.throws(()=>parseDistance(value));
  assert.equal(durationText(959.6),'00:16:00');
});

test('已确认的自定义方案可沿原五阶段模拟完成，提交保留审阅过的距离、时长与传感器',async()=>{
  const store=new Store(null);await seedDemo(store);const calls:string[]=[];
  const engine=new Engine(store,async(input,init)=>{calls.push(new URL(String(input)).pathname.split('/').at(-1)!);return demoFetch(input,init);});
  await engine.initialize();await engine.checkSchool();calls.length=0;
  const a=store.state.accounts[0]!,prepared=await engine.prepareDefault(a.id,{distanceKm:3.01,durationSec:1140});
  assert.equal(calls.length,0);const reviewed=structuredClone(prepared),task=await engine.start(a.id,prepared);
  assert.equal(task.phase,'waiting');assert.deepEqual(calls,['inSportTime','sportsId']);
  await engine.fastForwardDemo(task.id);assert.equal(task.phase,'done');assert.deepEqual(task.prepared,reviewed);
  assert.deepEqual(calls,['inSportTime','sportsId','prejudgment','savesports','sensorZipFile']);assert.equal(task.prepared.sensor.length,11400);
  await engine.shutdown();
});

test('真实 TUI 预览刷新、自定义、失败保留与取消确认全程零网络，不创建任务',()=>{
  const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','tests/smoke/oneshot-ui-smoke.ts'],{encoding:'utf8',timeout:15_000}));
  assert.equal(result.ok,true);assert.equal(result.requests,0);assert.equal(result.tasks,0);assert.ok(result.refreshes>=3);
});

test('运动链任一步 HTTP 失败即停止，即使正文业务码 200 也不能进入下一步或自动重试',async()=>{
  const chain=['inSportTime','sportsId','prejudgment','savesports','sensorZipFile'];
  for(const failure of chain){
    const store=new Store(null);await seedDemo(store);const calls:string[]=[];
    const e=new Engine(store,async(input,init)=>{
      const endpoint=new URL(String(input)).pathname.split('/').at(-1)!;
      if(chain.includes(endpoint))calls.push(endpoint);
      const response=await demoFetch(input,init);
      return endpoint===failure?new Response(await response.text(),{status:503,headers:response.headers}):response;
    });
    await e.initialize();await e.checkSchool();const a=store.state.accounts[0]!,p=await e.prepareDefault(a.id),task=await e.start(a.id,p);
    if(task.phase==='waiting')await e.fastForwardDemo(task.id);
    assert.equal(task.phase,'review');assert.equal(task.result,undefined);assert.match(task.note,/HTTP 503/);
    assert.deepEqual(calls,chain.slice(0,chain.indexOf(failure)+1));assert.equal(task.steps!.at(-1)!.httpStatus,503);
    const count=calls.length;await e.tick();assert.equal(calls.length,count);await e.shutdown();
  }
  const store=new Store(null);await seedDemo(store);
  const e=new Engine(store,async(input,init)=>String(input).includes('/inSportTime')?Response.json({code:2001},{status:503}):demoFetch(input,init));
  await e.initialize();await e.checkSchool();const a=store.state.accounts[0]!,token=a.session!.token;
  await e.start(a.id,await e.prepareDefault(a.id));assert.equal(a.session!.status,'saved');assert.equal(a.session!.token,token);await e.shutdown();
});
