import {LocalAppClient}from'../../src/app/local-client.js';
import assert from 'node:assert/strict';
import { Store } from '../../src/runtime/storage.js';
import { Engine } from '../../src/runtime/engine.js';
import { seedDemo } from '../../src/core/demo.js';
import { TerminalUI } from '../../src/ui/index.js';
import { memoryTerminal } from './memory-terminal.js';

const store=new Store(null);await seedDemo(store);let requests=0,refreshes=0;
const engine=new Engine(store,async()=>{requests++;throw Error('Unexpected network');});await engine.initialize();
const terminal=memoryTerminal(),{stdout}=terminal;
const ui=new TerminalUI(new LocalAppClient(engine),true,true,false,terminal),done=ui.run();
await ui.flush();await new Promise(r=>setImmediate(r));
const send=(name:string,ch='',ctrl=false)=>ui.controller.handle(ch,{name,ctrl,meta:false});
const settle=async()=>{const start=Date.now();while(ui.view.busy){if(Date.now()-start>5_000)throw Error('UI action timeout');await new Promise(r=>setTimeout(r,1));}};
await ui.flush();await new Promise(r=>setImmediate(r));
const key=async(name:string,ch='')=>{send(name,ch);await settle();await ui.flush();};
const target=async(name:string,value:string)=>{send(name,name);assert.ok(ui.view.form);send('u','',true);send('input',value);await key('return');};
try{
  await key('return');await key('return');assert.equal(ui.view.screen,'oneshot');const first=ui.view.preview!;
  for(let i=0;i<3;i++){const old=ui.view.preview!;await key('r','r');assert.notEqual(ui.view.preview!.seed,old.seed);refreshes++;}
  assert.equal(requests,0);assert.equal(store.state.tasks.length,0);
  await target('t','19:00');assert.equal(ui.view.preview!.durationSec,1140);
  await target('d','3.01');assert.equal(ui.view.preview!.body.odometer,'3.01');const custom=ui.view.preview!;
  await target('d','4.00');assert.equal(ui.view.preview,custom);assert.match(ui.view.notice,/没有支持/);
  await key('r','r');assert.equal(ui.view.preview!.targets!.distanceKm,3.01);assert.equal(ui.view.preview!.durationSec,1140);refreshes++;
  for(const[columns,rows]of[[40,16],[118,38]]){stdout.columns=columns!;stdout.rows=rows!;stdout.emit('resize');}
  await key('0','0');assert.equal(ui.view.preview!.targets,undefined);assert.equal(first.routeId,ui.view.preview!.routeId);
  const reviewed=ui.view.preview;send('return');assert.equal(ui.view.form?.title,'开始一次');assert.equal(requests,0);
  send('escape');await settle();assert.equal(ui.view.preview,reviewed);assert.equal(store.state.tasks.length,0);
  await key('escape');assert.equal(ui.view.screen,'account');await key('escape');await key('q','q');await done;
  assert.equal(requests,0);assert.match(terminal.read(),/ONE-SHOT/);
  process.stdout.write(JSON.stringify({ok:true,requests,tasks:store.state.tasks.length,refreshes})+'\n');
}finally{await ui.controller.close();await done;terminal.dispose();}
