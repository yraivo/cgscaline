import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/runtime/storage.js';
import { Engine } from '../src/runtime/engine.js';
import { demoFetch, seedDemo } from '../src/core/demo.js';
import { taskSummary, recordStatus, taskLines, taskAccountLabel } from '../src/ui/task-view.js';
import { frame, stripAnsi } from '../src/render/theme.js';

test('相同结果使用相同描述，旧备注不会影响执行记录或详情显示',async()=>{
  const store=new Store(null);await seedDemo(store);const engine=new Engine(store,demoFetch);await engine.initialize();
  const account=store.state.accounts[0]!,task=await engine.start(account.id,await engine.prepareDefault(account.id));
  await engine.fastForwardDemo(task.id);
  task.result={accepted:true,businessValid:false,sportId:task.session!.sportId,isValid:'1',checkStatus:'0',reason:''};
  const old=structuredClone(task);old.id='other';old.accountLabel='second';
  task.note='请求链已完成，业务有效/审核状态请查看记录。';old.note='提交成功，待审核；已只读核对，isValid=1，checkStatus=0，原因为空。';
  store.state.tasks=[task,old];
  assert.equal(taskSummary(task),'提交成功 · 待审核');assert.equal(taskSummary(old),taskSummary(task));
  const text=stripAnsi(frame(store.state,{screen:'executions',selected:0,notice:''},118,38,false));
  assert.equal(text.split('提交成功 · 待审核').length-1,2);
  for(const output of [text,taskLines(task).join('\n'),taskLines(old).join('\n')])
    assert.doesNotMatch(output,/请求链|业务有效|只读核对|isValid=|checkStatus=/);
  await engine.shutdown();
});

test('账号改名后历史任务、详情和通知使用当前昵称，原任务快照保持不变',async()=>{
  const store=new Store(null);await seedDemo(store);const engine=new Engine(store,demoFetch);await engine.initialize();
  const account=store.state.accounts[0]!,task=await engine.start(account.id,await engine.prepareDefault(account.id));
  await engine.fastForwardDemo(task.id);const original=JSON.stringify(task);
  await engine.configure(account.id,{label:'yb'});
  assert.equal(taskAccountLabel(task,store.state),'yb');assert.match(taskLines(task,store.state)[0]!,/^yb ·/);
  const text=stripAnsi(frame(store.state,{screen:'executions',selected:0,notice:''},118,38,false));
  assert.match(text,/yb · 已提交/);assert.doesNotMatch(text,new RegExp(task.accountLabel));
  assert.equal(JSON.stringify(task),original);await engine.shutdown();
});

test('核对状态优先于提交时状态；查询未找到时不把旧缓存当成新结果',()=>{
  const task={phase:'done',result:{businessValid:false,isValid:'1',checkStatus:'0'},audit:{found:true,record:{isValid:'1',checkStatus:'1',inValidReason:''}}} as Parameters<typeof taskSummary>[0];
  assert.equal(taskSummary(task),'提交成功 · 已通过');
  task.audit!.found=false;assert.equal(taskSummary(task),'提交成功 · 上次查询未找到');
  assert.equal(recordStatus({isValid:'-1',checkStatus:'1',inValidReason:'4'}),'未通过');
  assert.equal(recordStatus({isValid:'1',checkStatus:'1',inValidReason:'4'}),'未通过');
  assert.equal(recordStatus({}),'已提交');
});
