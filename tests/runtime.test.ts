import type {AppClient}from'../src/app/contracts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectWorker, isAlive } from '../src/runtime/worker.js';
import { WorkerChannel, type WorkerAddress } from '../src/runtime/ipc.js';
import { Store, WindowsVault } from '../src/runtime/storage.js';
import { TaskNotifications } from '../src/runtime/notifications.js';
import { Engine } from '../src/runtime/engine.js';
import { seedDemo, demoFetch } from '../src/core/demo.js';
import { auditLabel, visibleTasks } from '../src/ui/task-view.js';
import { TerminalUI } from '../src/ui/index.js';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const execFileAsync=promisify(execFile);
async function until(check:()=>boolean,timeout=10_000){const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw Error('Timed out');await delay(40);}}
async function exerciseRemoteUI(engine:AppClient){
  const write=process.stdout.write.bind(process.stdout),rawMode=process.stdin.setRawMode;
  const props=[[process.stdin,'isTTY'],[process.stdout,'isTTY'],[process.stdout,'columns'],[process.stdout,'rows']] as const;
  const descriptors=props.map(([object,key])=>Object.getOwnPropertyDescriptor(object,key));let output='';
  process.stdout.write=((chunk:unknown,encoding:unknown,callback?:()=>void)=>{output+=String(chunk);if(typeof encoding==='function')queueMicrotask(encoding as ()=>void);if(callback)queueMicrotask(callback);return true;}) as typeof process.stdout.write;
  for(const[object,key]of props)Object.defineProperty(object,key,{value:key==='columns'?118:key==='rows'?38:true,writable:true,configurable:true});
  process.stdin.setRawMode=()=>process.stdin;
  const ui=new TerminalUI(engine,true,true,false),done=ui.run();
  const send=(name:string,ch='',ctrl=false)=>ui.controller.handle(ch,{name,ctrl,meta:false});
  const key=async(name:string,ch='')=>{send(name,ch);await until(()=>!ui.view.busy,15_000);await ui.flush();};
  try{
    await key('/','/');await key('up');await key('return');await key('down');send('return');assert.equal(ui.view.form?.title,'并发上限');
    send('u','',true);send('input','3');await key('return');assert.equal(engine.state.settings.maxConcurrent,3);
    await key('escape');assert.equal(ui.view.screen,'menu');
    await key('escape');assert.equal(ui.view.screen,'home');
    await key('return');await key('return');assert.equal(ui.view.screen,'oneshot');
    assert.ok(ui.view.preview!.sensorSampleCount!>0);const seed=ui.view.preview!.seed;
    await key('r','r');assert.notEqual(ui.view.preview!.seed,seed);
    await key('escape');await key('escape');await key('h','h');assert.equal(ui.view.screen,'executions');
    await key('escape');await key('q','q');await done;
    assert.match(output,/CGSCALINE/);assert.match(output,/后台在线/);assert.match(output,/执行记录/);
  }finally{
    if(!ui.controller.closed)await ui.controller.quit().catch(()=>{});
    process.stdout.write=write;process.stdin.setRawMode=rawMode;
    props.forEach(([object,key],i)=>{const descriptor=descriptors[i];if(descriptor)Object.defineProperty(object,key,descriptor);else Reflect.deleteProperty(object,key);});
  }
}

test('后台隔离：断开后继续、重连不重发、崩溃后暂停并保留 sportId，拒绝错误认证并隐藏密钥',
  {skip:process.platform!=='win32',timeout:150_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'cgscaline-worker-test-'));
  const options={demo:true,entry:resolve('src/cli.ts'),notifications:false};
  let client:AppClient|undefined,pid=0;
  const address=async()=>JSON.parse((await new WindowsVault().unprotect(await readFile(join(root,'worker.dpapi')))).toString()) as WorkerAddress;
  try{
    // The actual CLI parent exits; its detached child must remain available.
    const launched=await execFileAsync(process.execPath,['--import','tsx',resolve('src/cli.ts'),'--demo','--headless','--data-dir',root,'--no-notifications'],{timeout:60_000});
    assert.match(launched.stdout,/CGSCALINE 后台运行中/);
    client=await connectWorker(root,{...options,start:false});let descriptor=await address();pid=descriptor.pid;
    await assert.rejects(connectWorker(root,{...options,demo:false,start:false}),/模式不匹配/);
    const a=client.state.accounts[0]!;
    assert.equal(client.background,true);assert.equal('token'in a.session!,false);assert.equal('secret'in a.session!,false);
    let disclosed=false;
    await assert.rejects(WorkerChannel.connect({...descriptor,key:'0'.repeat(64)},()=>{disclosed=true;}),/验证/);
    assert.equal(disclosed,false);
    await exerciseRemoteUI(client);client=await connectWorker(root,{...options,start:false});
    const p=await client.commands.prepareDefault(a.id,{durationSec:1140});assert.equal('sensor'in p,false);assert.equal(p.sensorSampleCount,11400);
    const task=await client.commands.start(a.id,p);assert.equal(task.phase,'waiting');const sportId=task.session!.sportId;
    assert.equal('sensor'in task.prepared,false);assert.equal('coordinate'in task.prepared.body,false);
    const starts=task.steps!.filter(s=>s.endpoint==='sportsId').length;assert.equal(starts,1);
    await client.close();client=await connectWorker(root,{...options,start:false});
    assert.equal((await address()).pid,pid);assert.equal(client.state.tasks[0]!.phase,'waiting');
    assert.equal(client.state.tasks[0]!.session!.sportId,sportId);assert.equal(client.state.tasks[0]!.steps!.filter(s=>s.endpoint==='sportsId').length,1);
    await client.commands.fastForwardDemo(task.id);assert.equal(client.state.tasks[0]!.phase,'done');
    assert.deepEqual(client.state.tasks[0]!.steps!.map(s=>s.endpoint),['inSportTime','sportsId','prejudgment','savesports','sensorZipFile']);
    // A second approved demo task is interrupted after its acknowledged begin.
    const p2=await client.commands.prepareDefault(a.id),running=await client.commands.start(a.id,p2);const originalSession=structuredClone(running.session!);
    process.kill(pid,'SIGKILL');await until(()=>!isAlive(pid));await client.close();client=undefined;
    client=await connectWorker(root,options);descriptor=await address();pid=descriptor.pid;
    const recovered=client.state.tasks.find(t=>t.id===running.id)!;
    assert.equal(recovered.phase,'paused');assert.equal(recovered.resumePhase,'waiting');assert.deepEqual(recovered.session,originalSession);
    assert.equal(recovered.steps!.filter(s=>s.endpoint==='sportsId').length,1);
    await client.commands.resume(running.id);assert.deepEqual(client.state.tasks.find(t=>t.id===running.id)!.session,originalSession);
    await client.commands.stopBackground();await client.close();client=undefined;await until(()=>!isAlive(pid));
    const persisted=new Store(root);await persisted.open();
    try{const saved=persisted.state.tasks.find(t=>t.id===running.id)!;assert.equal(saved.phase,'paused');assert.equal(saved.prepared.sensor.length>0,true);assert.equal(saved.prepared.body.coordinate!.length>200,true);}
    finally{persisted.close();}
    assert.equal((await readdir(root)).includes('worker.dpapi'),false);
    const ciphertext=await readFile(join(root,'state.dpapi'));assert.equal(ciphertext.includes(Buffer.from('demo.payload.signature')),false);
  }finally{
    if(client){await client.commands.stopBackground().catch(()=>{});await client.close();}
    if(pid&&isAlive(pid))process.kill(pid,'SIGKILL');
    await until(()=>!pid||!isAlive(pid)).catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('账号配置白名单不能覆盖会话、账号 ID 或对象原型',async()=>{
  const store=new Store(null);await seedDemo(store);const engine=new Engine(store,demoFetch);await engine.initialize();
  const a=store.state.accounts[0]!,before=JSON.stringify(a);
  for(const change of [{session:{token:'replacement'}},{id:'replacement'},JSON.parse('{"__proto__":{"session":"replacement"}}')])
    await assert.rejects(engine.configure(a.id,change as never),/不允许修改/);
  assert.equal(JSON.stringify(a),before);await engine.shutdown();
});

test('核对只匹配此任务 sportId，复用列表缓存，不按时间猜测，不改写执行状态',async()=>{
  const store=new Store(null);await seedDemo(store);const requests:string[]=[];let records:any[]=[];
  const engine=new Engine(store,async(input,init)=>{
    const endpoint=new URL(String(input)).pathname.split('/').at(-1)!;requests.push(endpoint);
    if(endpoint==='sportlist')return Response.json({code:200,data:records});return demoFetch(input,init);
  });await engine.initialize();const a=store.state.accounts[0]!;
  const planned=(await engine.queuePlan([a.id],Date.now()+60_000,0))[0]!;
  await assert.rejects(engine.reconcileTask(planned.id),/sportId/);assert.equal(requests.length,0);await engine.archive(planned.id);
  const task=await engine.start(a.id,await engine.prepareDefault(a.id));await engine.fastForwardDemo(task.id);
  const sportId=task.session!.sportId,phase=task.phase;requests.length=0;
  records=[{sportId:'different',isValid:'1',checkStatus:'1',beginTime:'same',odometer:'3.03'}];
  assert.equal((await engine.reconcileTask(task.id)).found,false);assert.equal(auditLabel(task),'本次查询未找到');assert.deepEqual(requests,['sportlist']);
  requests.length=0;await engine.reconcileTask(task.id,false);assert.equal(requests.length,0);
  records=[{sportId,isValid:'1',checkStatus:'0',beginTime:'same',odometer:'3.03'}];
  await engine.reconcileTask(task.id);assert.equal(auditLabel(task),'待审核');assert.equal(task.phase,phase);
  records=[];await engine.reconcileTask(task.id);assert.equal(task.audit!.found,false);assert.equal(task.audit!.record!.sportId,sportId);
  assert.deepEqual(visibleTasks(store.state,true).map(t=>t.id),[task.id]);assert.equal(visibleTasks(store.state).length,0);
  await engine.shutdown();
});

test('通知只由阶段变化触发，合并并去重；设置关闭后不发送',async()=>{
  const store=new Store(null);await seedDemo(store);const engine=new Engine(store,demoFetch);await engine.initialize();
  const a=store.state.accounts[0]!,queued=(await engine.queuePlan([a.id],Date.now()+60_000,0))[0]!;
  const messages:string[]=[],notifier=new TaskNotifications(store.state,message=>messages.push(message));
  queued.phase='review';notifier.update(store.state);notifier.update(store.state);notifier.flush();
  assert.equal(messages.length,1);assert.match(messages[0]!,/需要核对/);
  queued.phase='done';notifier.update(store.state);notifier.flush();assert.equal(messages.length,2);
  store.state.settings.notifications=false;queued.phase='review';notifier.update(store.state);notifier.flush();assert.equal(messages.length,2);
  notifier.close();await engine.shutdown();
});
