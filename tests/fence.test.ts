import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExperimentFence } from '../src/track/fence.js';
import { Engine } from '../src/runtime/engine.js';
import { Store } from '../src/runtime/storage.js';
import { BASE, deviceHeaders, UPDATE_BASE, UserError } from '../src/core/model.js';
import { demoSecret } from '../src/core/demo.js';

const base=BASE, version=UPDATE_BASE+'api/version';
const headers={imei:'fake-imei',cgAuthorization:'private-token'};
test('真实会话实验始终禁止续期、任务开始、sportId 和提交端点',async()=>{
  let calls=0; const fence=new ExperimentFence(async()=>{calls++;return Response.json({code:200});},'fake001','fake-imei');
  for(const phase of ['public','login','query'] as const) {
    fence.phase=phase;
    for(const [path,method] of [['api/l/v6/issue','POST'],['api/l/v6/inSportTime','POST'],['api/l/v6/sportsId','GET'],['api/l/v7/savesports','POST'],['api/l/v1/sensorZipFile','POST']])
      await assert.rejects(fence.fetch(base+path,{method,headers}),/禁止续期/);
  }
  assert.equal(calls,0);assert.deepEqual(fence.events,[]);
});

test('实验登录限目标账号和设备，仅在显式阶段允许一次，失败也不重试',async()=>{
  let calls=0; const fence=new ExperimentFence(async()=>{calls++;throw new Error('timeout');},'fake001','fake-imei');
  const login=base+'api/f/v6/login', request={method:'POST',headers:{imei:'fake-imei'},body:'username=fake001&password=private-password'};
  await assert.rejects(fence.fetch(login,request),/一次显式登录/);
  fence.phase='login';
  await assert.rejects(fence.fetch(login,{...request,body:'username=fake002'}),/一次显式登录/);
  await assert.rejects(fence.fetch(login,{...request,headers:{imei:'other-imei'}}),/一次显式登录/);
  await assert.rejects(fence.fetch(login,request),/timeout/);
  await assert.rejects(fence.fetch(login,request),/一次显式登录/);
  assert.equal(calls,1);assert.equal(JSON.stringify(fence.events).includes('private-password'),false);
});

test('只读查询限两次且不能串账号或设备',async()=>{
  let calls=0;const fence=new ExperimentFence(async()=>{calls++;return Response.json({code:200});},'fake001','fake-imei');
  const url=base+'api/l/v7/sportlist?xh=fake001';fence.phase='query';
  await assert.rejects(fence.fetch(url.replace('fake001','fake002'),{headers}),/两次只读/);
  await assert.rejects(fence.fetch(url,{headers:{...headers,imei:'other-imei'}}),/两次只读/);
  await fence.fetch(url,{headers});await fence.fetch(url,{headers});
  await assert.rejects(fence.fetch(url,{headers}),/两次只读/);assert.equal(calls,2);
  assert.equal(JSON.stringify(fence.events).includes('private-token'),false);
});

test('公共检查不接受凭据、陌生主机；证据只保存状态与端点',async()=>{
  let calls=0;const fence=new ExperimentFence(async()=>{calls++;return Response.json({code:200,data:'private-response'});},'fake001','fake-imei');
  for(const header of ['cgAuthorization','imei','client','Authorization','Cookie','SECRET'])
    await assert.rejects(fence.fetch(version,{headers:{[header]:'private-value'}}),/公共检查携带凭据/);
  await assert.rejects(fence.fetch('https://example.invalid/cgapp/api/version'),/禁止续期/);
  await fence.fetch(version,{headers:{Accept:'application/json','app-key':'cgsoft'}});
  assert.equal(calls,1);assert.equal(fence.events[0]!.code,200);
  assert.deepEqual(Object.keys(fence.events[0]!).sort(),['code','elapsedMs','endpoint','method','phase','status']);
  assert.equal(JSON.stringify(fence.events).includes('private-response'),false);
});

test('正式 Engine/Transport 登录使用 URLSearchParams 可穿过实验白名单，本地阻断保持原错误',async()=>{
  const store=new Store(null),engine=new Engine(store),a=await engine.addAccount('fake','fake001','21');
  let loginCalls=0;
  const original=globalThis.fetch,fence=new ExperimentFence(async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/version'))return Response.json({code:200,data:'',message:'未发现新版本'});
    if(path.endsWith('/login')){
      loginCalls++;assert.ok(init?.body instanceof URLSearchParams);
      assert.equal(init.body.get('username'),a.username);
      return Response.json({code:200,data:{token:`fake.payload.signature.${demoSecret}.1900000000000`,info:{xh:a.username}}});
    }
    if(path.endsWith('/sportlist'))return Response.json({code:200,data:[]});
    throw new Error('unexpected upstream request');
  },a.username,deviceHeaders(a.device).imei);
  globalThis.fetch=fence.fetch;
  try{
    await engine.configureSchool('21');await engine.checkSchool();
    fence.phase='login';await engine.login(a.id,'fake-password');assert.equal(loginCalls,1);
    fence.phase='query';assert.deepEqual(await engine.records(a.id),[]);
    await assert.rejects(engine.client(a).renew(a),error=>error instanceof UserError&&/禁止续期/.test(error.message));
    assert.equal(fence.events.filter(e=>e.endpoint.endsWith('/login')).length,1);
    assert.equal(fence.events.filter(e=>e.endpoint.endsWith('/issue')).length,0);
    assert.equal(JSON.stringify(fence.events).includes('fake-password'),false);
  }finally{await engine.shutdown();globalThis.fetch=original;}
});
