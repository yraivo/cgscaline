import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateSensorExperiment,sensorMetrics,sensorSeams,assessSensorTimeline} from '../src/track/sensor-synth.js';
test('片段实验可复现、准确输出10Hz并保留来源；不改动捐赠序列',()=>{
  const donors=[{id:'a',values:Array.from({length:500},(_,i)=>4+i%30)}],before=JSON.stringify(donors);
  const generated=generateSensorExperiment(donors,61.3,17);
  assert.equal(generated.values.length,613);assert.deepEqual(generated,generateSensorExperiment(donors,61.3,17));
  assert.notDeepEqual(generated.values,generateSensorExperiment(donors,61.3,18).values);assert.equal(JSON.stringify(donors),before);
  assert.ok(generated.values.some(v=>v>11.5));
  for(const [index,block] of generated.blocks.entries())for(let i=block.overlap;i<Math.min(block.length,(generated.blocks[index+1]?.targetStart??generated.values.length)-block.targetStart);i++)assert.equal(generated.values[block.targetStart+i],donors[0]!.values[block.sourceStart+i]);
});
test('v2 衔接保留来源与精度，常数段没有接缝；时间窗相近仍不声明同步',()=>{
  const donors=[{id:'recorded',values:Array(500).fill(9.8)}];
  const result=generateSensorExperiment(donors,100,8,'recorded-blocks-v2');
  assert.deepEqual(result,generateSensorExperiment(donors,100,8,'recorded-blocks-v2'));
  assert.equal(result.values.length,1000);assert.ok(result.values.every(v=>v===9.8));
  assert.ok(result.blocks.length>1);assert.equal(sensorSeams(result.values,result.blocks).meanDelta,0);
  assert.equal(assessSensorTimeline(1000,100).status,'duration-compatible');
  assert.equal(assessSensorTimeline(1000,300).status,'mismatch');
  assert.equal(assessSensorTimeline(1000,undefined).status,'unknown');
  assert.equal(assessSensorTimeline(1000,101,0).status,'mismatch');
  assert.throws(()=>assessSensorTimeline(1000,100,-1));
});
test('实验拒绝空来源和损坏采样；常数序列统计合法',()=>{
  for(const donors of[[],[{id:'a',values:[NaN]}],[{id:'a',values:Array(100).fill(-1)}]])assert.throws(()=>generateSensorExperiment(donors,10,1));
  assert.throws(()=>generateSensorExperiment([{id:'a',values:Array(100).fill(9)}],Infinity,1));
  assert.deepEqual(sensorMetrics([9,9,9]),{count:3,mean:9,std:0,p01:9,p99:9,lag1:0,meanAbsoluteDelta:0});
});
