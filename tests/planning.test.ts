import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/runtime/storage.js';
import {Engine} from '../src/runtime/engine.js';
import {demoFetch,seedDemo} from '../src/core/demo.js';
import {parseStart} from '../src/runtime/scheduling.js';
import {geometryIssues,geometryErrors,geometryWarnings} from '../src/track/geometry.js';

async function fixture() {
  const store=new Store(null);await seedDemo(store);
  store.state.accounts[1]!.sourceMode='public';
  const paths:string[]=[];
  const engine=new Engine(store,async(url,init)=>{paths.push(new URL(String(url)).pathname);return demoFetch(url,init);});
  await engine.initialize();return{store,engine,paths,a:store.state.accounts[0]!,b:store.state.accounts[1]!};
}
test('公共版本检查没有账号也可以执行，不需要密码或 TOKEN',async()=>{
  const store=new Store(null),headers:Headers[]=[];
  const e=new Engine(store,async(url,init)=>{headers.push(new Headers(init?.headers));assert.ok(String(url).includes('/api/version?'));return demoFetch(url,init);});
  await e.configureSchool('school');await e.checkSchool();
  assert.equal(store.state.accounts.length,0);assert.equal(store.state.settings.compatibility?.status,'ok');
  assert.equal(headers.length,1);assert.equal(headers[0]!.get('cgAuthorization'),null);
});
test('公共检查结果由相同学校/版本账号复用，账号无需重复做版本请求',async()=>{
  const{store,engine,paths,a}=await fixture();await engine.checkSchool();
  await engine.records(a.id);assert.equal(paths.filter(p=>p.endsWith('/version')).length,1);
  assert.equal(store.state.settings.compatibility?.status,'ok');
});

test('账号出口检查无需登录，使用公共版本请求且不携带身份头',async()=>{
  const store=new Store(null),calls:Array<{url:string;headers:Headers}>=[];
  const e=new Engine(store,async(url,init)=>{calls.push({url:String(url),headers:new Headers(init?.headers)});return demoFetch(url,init);});
  const a=await e.addAccount('fake','placeholder1','21');
  await e.configure(a.id,{proxy:'socks5://127.0.0.1:1081'});
  const result=await e.check(a.id);assert.equal(result.status,'ok');assert.equal(a.session,undefined);assert.equal(a.lastLoginAt,undefined);
  assert.equal(calls.length,1);assert.equal(new URL(calls[0]!.url).origin,'https://tyapp.chingo.cn');
  for(const name of ['cgAuthorization','imei','client','SECRET'])assert.equal(calls[0]!.headers.get(name),null);
});
test('错峰计划保存时不申请 sportId，到最早开始时间才执行',async()=>{
  const{engine,paths,a,b}=await fixture();const first=Date.now()+60_000;
  const tasks=await engine.queuePlan([a.id,b.id],first,120_000);
  assert.equal(tasks[1]!.plannedStartAt!-tasks[0]!.plannedStartAt!,120_000);
  assert.equal(paths.length,0);await engine.tick();assert.equal(paths.length,0);
  tasks[0]!.plannedStartAt=Date.now()-1;await engine.tick();
  assert.equal(tasks[0]!.phase,'waiting');assert.equal(tasks[1]!.phase,'queued');
  assert.equal(paths.filter(p=>p.endsWith('/sportsId')).length,1);
});
test('计划受全局并发上限限制，结束一个后才开始下一个',async()=>{
  const{store,engine,a,b}=await fixture();store.state.settings.maxConcurrent=1;
  const tasks=await engine.queuePlan([a.id,b.id],Date.now(),0);await engine.tick();
  assert.equal(tasks[0]!.phase,'waiting');assert.equal(tasks[1]!.phase,'queued');
  await engine.fastForwardDemo(tasks[0]!.id);
  assert.equal(tasks[0]!.phase,'done');assert.equal(tasks[1]!.phase,'waiting');
});
test('同时手动开始也不会穿透全局并发上限',async()=>{
  const{store,engine,a,b}=await fixture();store.state.settings.maxConcurrent=1;
  const[pA,pB]=await Promise.all([engine.prepareDefault(a.id),engine.prepareDefault(b.id)]);
  const results=await Promise.allSettled([engine.start(a.id,pA),engine.start(b.id,pB)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(store.state.tasks.length,1);
});
test('退出/重启不会自动执行排队任务，显式恢复后才重新排队',async()=>{
  const{store,engine,paths,a}=await fixture();const[t]=await engine.queuePlan([a.id],Date.now()+60_000,0);
  await engine.initialize();assert.equal(t!.phase,'paused');assert.equal(t!.resumePhase,'queued');
  await engine.tick();assert.equal(paths.length,0);
  await engine.resume(t!.id);assert.equal(t!.phase,'queued');assert.equal(store.state.tasks.length,1);
});
test('删除账号清除私有库/凭据/未开始任务，共享库与其他账号保留',async()=>{
  const{store,engine,a,b}=await fixture();const privateId=store.state.libraries[0]!.id;
  await engine.queuePlan([a.id],Date.now()+60_000,0);await engine.deleteAccount(a.id);
  assert.equal(store.state.accounts.length,1);assert.equal(store.state.accounts[0]!.id,b.id);
  assert.equal(store.state.tasks.length,0);assert.equal(store.state.libraries.length,1);
  assert.equal(store.state.libraries[0]!.scope,'public');assert.equal(await store.getLibrary(privateId),undefined);
});
test('已经开始或结果未知的账号不能被直接删除',async()=>{
  const{engine,a}=await fixture();const t=await engine.start(a.id,await engine.prepareDefault(a.id));
  await assert.rejects(engine.deleteAccount(a.id),/已开始或待核对/);
  await engine.pause(t.id);await assert.rejects(engine.deleteAccount(a.id),/已开始或待核对/);
  await engine.archive(t.id);await engine.deleteAccount(a.id);
});
test('上海时间解析与次日规则不依赖宿主机时区',()=>{
  const now=Date.parse('2026-10-31T10:00:00Z');
  assert.equal(parseStart('21:30',now),Date.parse('2026-10-31T13:30:00Z'));
  assert.equal(parseStart('17:00',now),Date.parse('2026-11-01T09:00:00Z'));
  assert.equal(parseStart('+10',now),now+600_000);assert.throws(()=>parseStart('24:00',now));
});
test('GPS 速度峰值保留为提示，不把本地阈值当作平台规则',async()=>{
  const{engine,paths,a}=await fixture();const p=await engine.prepareDefault(a.id);
  assert.deepEqual(geometryIssues(p),[]);
  const points=p.body.coordinate!;points[10]!.a+=.01;
  assert.ok(geometryWarnings(p).length);assert.deepEqual(geometryErrors(p),[]);
  assert.equal((await engine.start(a.id,p)).phase,'waiting');
  assert.ok(paths.some(p=>p.endsWith('/sportsId')));
});

test('逆序位移、里程膨胀与非法坐标仍在外发前拦截',async()=>{
  const{engine,paths,a}=await fixture();const p=await engine.prepareDefault(a.id);
  const reversed=structuredClone(p);reversed.body.coordinate![10]!.t=reversed.body.coordinate![9]!.t;
  reversed.body.coordinate![10]!.a+=.001;
  const inflated=structuredClone(p);inflated.body.odometer=String(p.sourceDistanceKm!*1.3);
  const invalid=structuredClone(p);invalid.body.coordinate![10]!.a=Number.NaN;
  const outside=structuredClone(p);outside.body.coordinate![10]!.a=91;
  for(const bad of [reversed,inflated,invalid,outside])await assert.rejects(engine.start(a.id,bad),/轨迹数据有误/);
  assert.equal(paths.length,0);
});
