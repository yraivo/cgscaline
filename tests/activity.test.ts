import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ACTIVITY_LIMIT,activityText,recordActivity,recentActivity} from '../src/core/activity.js';
import {emptyState,identity,newAccount} from '../src/core/model.js';
import {Store} from '../src/runtime/storage.js';
import {Engine} from '../src/runtime/engine.js';
import {demoFetch,demoSession,seedDemo} from '../src/core/demo.js';

test('事件只保存白名单元数据，丢弃自由文本和凭据，且限制容量',()=>{
  const state=emptyState(),a=newAccount('fake','fake-account','school');state.accounts.push(a);
  for(let i=0;i<ACTIVITY_LIMIT+5;i++)recordActivity(state,'request',{accountId:a.id,request:'sportlist',status:200,count:i,
    token:'private-token',password:'private-password',url:'http://user:private-proxy@example.test',body:'private-body',message:'private-message'} as never);
  assert.equal(state.activity!.length,ACTIVITY_LIMIT);const serialized=JSON.stringify(state.activity);
  for(const secret of['private-token','private-password','private-proxy','private-body','private-message'])assert.equal(serialized.includes(secret),false);
  assert.equal(recentActivity(state,undefined,0).length,0);assert.ok(activityText(recentActivity(state)[0]!).includes('HTTP 200'));
});
test('启动日志只是本地档案与会话载入，不联网，也不把保存会话说成已经远端验证',async()=>{
  const store=new Store(null);await seedDemo(store);let requests=0;
  const engine=new Engine(store,async()=>{requests++;throw Error('unexpected network');});await engine.initialize();
  assert.equal(requests,0);assert.deepEqual(store.state.activity!.map(e=>e.code),['startup','sessions']);
  const labels=recentActivity(store.state).map(activityText).join('\n');assert.match(labels,/载入本地会话/);assert.equal(labels.includes('已验证'),false);
});
test('HTTP 200 的鉴权失败只记录 HTTP 状态和真实失败结果，不记录响应正文或伪报业务成功',async()=>{
  const store=new Store(null);await seedDemo(store);
  const engine=new Engine(store,async(input,init)=>String(input).includes('/currentTimeMillis')
    ?Response.json({code:2001,data:{token:'server-private-token',secret:'server-private-secret'}}):demoFetch(input,init));
  await engine.initialize();await engine.checkSchool();const a=store.state.accounts[0]!;await engine.information(a.id,true);
  const http=store.state.activity!.find(e=>e.code==='request'&&e.request==='currentTimeMillis')!;
  assert.equal(http.status,200);assert.equal(http.level,'info');assert.equal(a.session!.status,'invalid');
  const outcome=store.state.activity!.findLast(e=>e.code==='information')!;assert.equal(outcome.count,0);assert.equal(outcome.level,'warn');
  assert.equal(JSON.stringify(store.state.activity).includes('server-private'),false);
});
test('切换配色只改本地显示偏好，保持账号设备和会话，重开仍保留选择',async()=>{
  const store=new Store(null);await seedDemo(store);let requests=0;
  const engine=new Engine(store,async()=>{requests++;throw Error('unexpected network');});await engine.initialize();
  const a=store.state.accounts[0]!,before=JSON.stringify(a),beforeIdentity=identity(a);
  await engine.setColorTheme('spectrum');assert.equal(requests,0);assert.equal(JSON.stringify(a),before);assert.equal(identity(a),beforeIdentity);
  const next=new Store(null);next.state=structuredClone(store.state);await new Engine(next,async()=>{requests++;throw Error('unexpected');}).initialize();
  assert.equal(next.state.settings.colorTheme,'spectrum');assert.equal(requests,0);
});
test('最近事件按账号筛选；删除账号会删除它的事件，不影响其他账号',async()=>{
  const store=new Store(null),engine=new Engine(store,demoFetch);const a=await engine.addAccount('a','fake-a','21'),b=await engine.addAccount('b','fake-b','21');
  a.session=demoSession(a);b.session=demoSession(b);await engine.checkSchool();await engine.records(a.id);await engine.records(b.id);
  assert.ok(recentActivity(store.state,a.id,80).every(e=>!e.accountId||e.accountId===a.id));
  await engine.deleteAccount(a.id);assert.ok(store.state.activity!.every(e=>e.accountId!==a.id));assert.ok(store.state.activity!.some(e=>e.accountId===b.id));
});
