import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {Store,type Vault} from '../src/runtime/storage.js';
import {Engine} from '../src/runtime/engine.js';import {seedDemo,demoFetch} from '../src/core/demo.js';
import type {Task,State} from '../src/core/model.js';

class TestVault implements Vault{
  key=randomBytes(32);encrypted:Buffer[]=[];reads=0;failAt=0;
  async protect(data:Buffer){
    this.encrypted.push(Buffer.from(data));if(this.encrypted.length===this.failAt)throw Error('disk simulation');
    const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);
    return Buffer.concat([iv,c.update(data),c.final(),c.getAuthTag()]);
  }
  async unprotect(data:Buffer){this.reads++;const c=createDecipheriv('aes-256-gcm',this.key,data.subarray(0,12));c.setAuthTag(data.subarray(-16));return Buffer.concat([c.update(data.subarray(12,-16)),c.final()]);}
}
async function fixture(){
  const memory=new Store(null);await seedDemo(memory);const engine=new Engine(memory,demoFetch);await engine.initialize();
  const prepared=await engine.prepareDefault(memory.state.accounts[0]!.id);
  const task:Task={id:randomUUID(),accountId:memory.state.accounts[0]!.id,accountLabel:'demo',identity:'demo',sessionId:'demo',createdAt:Date.now(),phase:'done',prepared,note:'demo'};
  memory.state.tasks.push(task);return structuredClone(memory.state);
}
async function setup(){const root=await mkdtemp(join(tmpdir(),'cgscaline-storage-'));const vault=new TestVault();const state=await fixture();return{root,vault,state};}
const json=async(root:string,vault:TestVault)=>JSON.parse((await vault.unprotect(await readFile(join(root,'state.dpapi')))).toString());

test('旧档案先保留加密备份，再拆分快照；历史按需加载、待执行完整恢复',async()=>{
  const {root,vault,state}=await setup();const pending=structuredClone(state.tasks[0]!);pending.id=randomUUID();pending.phase='queued';state.tasks.push(pending);
  const raw=await vault.protect(Buffer.from(JSON.stringify(state)));await writeFile(join(root,'state.dpapi'),raw);
  const s=new Store(root,vault);await s.open();
  try{
    await s.save();const disk=await json(root,vault);assert.equal(disk.schemaVersion,2);
    assert.ok(disk.tasks.every((t:Task)=>!t.prepared.sensor.length&&!t.prepared.body.coordinate!.length));
    const backup=(await readdir(root)).find(n=>n.startsWith('state-v1-'))!;assert.deepEqual(await readFile(join(root,backup)),raw);
    assert.equal(s.state.tasks[0]!.prepared.sensor.length,0);assert.deepEqual(await s.getTaskPrepared(state.tasks[0]!.id),state.tasks[0]!.prepared);
    s.close();const next=new Store(root,vault);await next.open();
    try{assert.equal(next.state.tasks[0]!.prepared.sensor.length,0);assert.deepEqual(next.state.tasks[1]!.prepared,pending.prepared);}
    finally{next.close();}
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('修改设置与任务阶段不重写快照；保存顺序正确且已存快照不能原地修改',async()=>{
  const {root,vault,state}=await setup();state.tasks[0]!.phase='paused';
  const s=new Store(root,vault);await s.open();s.state=state;
  try{
    await s.save();const payloads=()=>vault.encrypted.filter(b=>b[0]===0x1f&&b[1]===0x8b).length;
    assert.equal(payloads(),1);assert.throws(()=>s.state.tasks[0]!.prepared.sensor.push(123));
    s.state.settings.maxConcurrent=3;const first=s.save();s.state.settings.maxConcurrent=4;const second=s.save();await Promise.all([first,second]);
    assert.equal((await json(root,vault)).settings.maxConcurrent,4);
    s.state.tasks[0]!.phase='done';await s.save();await s.save();assert.equal(payloads(),1);
    assert.equal(s.state.tasks[0]!.prepared.sensor.length,0);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('切换索引前写入失败保留旧档案；重试复用已写入的快照',async()=>{
  const {root,vault,state}=await setup();const raw=await vault.protect(Buffer.from(JSON.stringify(state)));await writeFile(join(root,'state.dpapi'),raw);
  const s=new Store(root,vault);await s.open();vault.failAt=vault.encrypted.length+2;
  try{
    await assert.rejects(s.save(),/simulation/);assert.deepEqual(await readFile(join(root,'state.dpapi')),raw);
    vault.failAt=0;await s.save();assert.equal((await json(root,vault)).schemaVersion,2);
    assert.equal(vault.encrypted.filter(b=>b[0]===0x1f&&b[1]===0x8b).length,1);
    assert.deepEqual(await s.getTaskPrepared(state.tasks[0]!.id),state.tasks[0]!.prepared);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('缺失历史快照不阻止查看摘要；缺失待执行快照改为待核对且不能恢复执行',async()=>{
  const {root,vault,state}=await setup();state.tasks[0]!.phase='paused';state.tasks[0]!.resumePhase='queued';
  const s=new Store(root,vault);await s.open();s.state=state;await s.save();const file=(await readdir(root)).find(n=>n.startsWith('task-'))!;s.close();await unlink(join(root,file));
  const next=new Store(root,vault);await next.open();
  try{
    assert.equal(next.state.tasks[0]!.phase,'review');let calls=0;
    const e=new Engine(next,async()=>{calls++;throw Error('network');});await e.initialize();
    await assert.rejects(e.resume(state.tasks[0]!.id),/核对/);assert.equal(calls,0);
    await assert.rejects(next.getTaskPrepared(state.tasks[0]!.id),/恢复备份/);
    // Saving a broken task preserves the original reference instead of overwriting it with empty data.
    assert.equal((await json(root,vault)).tasks[0].preparedRef.sha256,file.split('-').at(-1)!.replace('.dpapi',''));
  }finally{next.close();await rm(root,{recursive:true,force:true});}
});

test('历史快照校验绑定所属账号，损坏不退回其他任务；删除任务清理文件',async()=>{
  const {root,vault,state}=await setup();const s=new Store(root,vault);await s.open();s.state=state;await s.save();
  try{
    const names=await readdir(root),file=names.find(n=>n.startsWith('task-'))!,raw=await readFile(join(root,file));
    const disk=await json(root,vault),original=disk.tasks[0].accountId;disk.tasks[0].accountId=randomUUID();
    await writeFile(join(root,'state.dpapi'),await vault.protect(Buffer.from(JSON.stringify(disk))));
    s.close();const wrongOwner=new Store(root,vault);await wrongOwner.open();
    await assert.rejects(wrongOwner.getTaskPrepared(state.tasks[0]!.id),/恢复备份/);wrongOwner.close();
    disk.tasks[0].accountId=original;await writeFile(join(root,'state.dpapi'),await vault.protect(Buffer.from(JSON.stringify(disk))));
    await s.open();
    raw[raw.length-1]=raw[raw.length-1]!^1;await writeFile(join(root,file),raw);await assert.rejects(s.getTaskPrepared(state.tasks[0]!.id),/恢复备份/);
    s.state.tasks=[];await s.save();assert.equal((await readdir(root)).some(n=>n.startsWith('task-')),false);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('替换快照生成新版本并在新索引提交后清理旧文件，摘要保留样本计数',async()=>{
  const {root,vault,state}=await setup(),sampleCount=state.tasks[0]!.prepared.sensor.length;const s=new Store(root,vault);await s.open();s.state=state;
  try{
    await s.save();const old=(await readdir(root)).find(n=>n.startsWith('task-'))!;
    assert.equal(s.state.tasks[0]!.prepared.sensorSampleCount,sampleCount);
    const p=structuredClone(await s.getTaskPrepared(state.tasks[0]!.id));p.seed++;
    s.state.tasks[0]!.prepared=p;await s.save();
    const files=(await readdir(root)).filter(n=>n.startsWith('task-'));assert.equal(files.length,1);assert.notEqual(files[0],old);
    assert.equal((await s.getTaskPrepared(state.tasks[0]!.id)).seed,p.seed);
    assert.ok(s.state.tasks[0]!.prepared.sensorSampleCount!>0);
  }finally{s.close();await rm(root,{recursive:true,force:true});}
});

test('新任务快照写入后索引失败，重开沿用旧索引并清理孤立文件',async()=>{
  const {root,vault,state}=await setup();const empty=structuredClone(state);empty.tasks=[];
  const s=new Store(root,vault);await s.open();s.state=empty;await s.save();
  s.state.tasks=state.tasks;vault.failAt=vault.encrypted.length+2;await assert.rejects(s.save());s.close();
  assert.equal((await readdir(root)).filter(n=>n.startsWith('task-')).length,1);
  vault.failAt=0;const next=new Store(root,vault);await next.open();
  try{
    assert.equal(next.state.tasks.length,0);await next.save();
    assert.equal((await readdir(root)).filter(n=>n.startsWith('task-')).length,0);
  }finally{next.close();await rm(root,{recursive:true,force:true});}
});
