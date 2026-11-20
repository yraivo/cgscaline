import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, type Task } from '../src/core/model.js';
import { nextTaskDelay, TaskScheduler } from '../src/runtime/task-scheduler.js';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const task=(phase:Task['phase'],at:number):Task=>({phase,plannedStartAt:at,session:{commitAtLocalMs:at}} as Task);
test('后台空闲、暂停或只有已完成任务时不设轮询；等待和排队按最早截止时间唤醒',()=>{
  const state=emptyState(),now=Date.now();
  assert.equal(nextTaskDelay(state,now),undefined);
  state.tasks=[task('done',now),task('paused',now),task('review',now)];assert.equal(nextTaskDelay(state,now),undefined);
  state.tasks=[task('waiting',now+500),task('queued',now+100)];assert.equal(nextTaskDelay(state,now),100);
  state.settings.maxConcurrent=1;assert.equal(nextTaskDelay(state,now),500);
  state.tasks=[task('queued',now+120000)];assert.equal(nextTaskDelay(state,now),30000);
  state.tasks=[task('waiting',now-100)];assert.equal(nextTaskDelay(state,now),0);
});
test('截止时间推进任务、完成后停止唤醒；重复状态更新不重复执行',async()=>{
  const state=emptyState();let ticks=0,failures=0;
  const scheduler=new TaskScheduler(()=>state,async()=>{
    ticks++;const current=state.tasks[0]!;
    if(current.phase==='queued'){current.phase='waiting';current.session!.commitAtLocalMs=Date.now()+30;}
    else current.phase='done';
  },()=>{failures++;});
  try{
    scheduler.start();await delay(60);assert.equal(ticks,0);
    state.tasks=[task('queued',Date.now()+30)];for(let i=0;i<15;i++)scheduler.update();
    const deadline=Date.now()+2000;while(state.tasks[0]!.phase!=='done'){if(Date.now()>deadline)throw Error('deadline missed');await delay(10);}
    assert.equal(ticks,2);assert.equal(failures,0);await delay(100);assert.equal(ticks,2);
    state.tasks=[task('queued',Date.now()+40)];scheduler.update();scheduler.stop();await delay(80);assert.equal(ticks,2);
  }finally{scheduler.stop();}
});
