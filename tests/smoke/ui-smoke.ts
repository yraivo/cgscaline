import {LocalAppClient}from'../../src/app/local-client.js';
/** 在隔离子进程中测试真实 UI 事件流；仅有内存档案与 demoFetch。 */
import assert from 'node:assert/strict';
import {Store} from '../../src/runtime/storage.js';
import {Engine} from '../../src/runtime/engine.js';
import {demoFetch,seedDemo} from '../../src/core/demo.js';
import {TerminalUI} from '../../src/ui/index.js';
import {terminalTitle} from '../../src/core/brand.js';
import {memoryTerminal} from './memory-terminal.js';

const store=new Store(null);await seedDemo(store);const requests:string[]=[];
const e=new Engine(store,async(input,init)=>{requests.push(new URL(String(input)).pathname);return demoFetch(input,init);});
await e.initialize();await e.checkSchool();
const terminal=memoryTerminal(),{stdin,stdout}=terminal;
const ui=new TerminalUI(new LocalAppClient(e),true,true,true,terminal),done=ui.run(),screens:string[]=[];

await ui.flush();await new Promise(r=>setImmediate(r));
const key=async(name:string,ch='')=>{
  ui.controller.handle(ch,{name,ctrl:false,meta:false});
  const start=Date.now();while(ui.view.busy){if(Date.now()-start>5_000)throw Error('UI action timed out');await new Promise(r=>setTimeout(r,1));}
  await ui.flush();screens.push(ui.view.screen);
};
try{
  assert.ok(terminal.read().includes(terminalTitle));
  let ticks=0;const originalTick=e.tick.bind(e);
  e.tick=async()=>{ticks++;await originalTick();};const beforeRender=ticks;
  for(let i=0;i<5;i++){ui.view.motion=3+i/20;ui.render();}assert.equal(ticks,beforeRender);
  stdin.write('\x1b[O');await new Promise(r=>setTimeout(r,80));await ui.flush();const frozen=terminal.read().length,backgroundTicks=ticks;
  await new Promise(r=>setTimeout(r,200));assert.equal(terminal.read().length,frozen);assert.equal(ticks,backgroundTicks);
  stdin.write('\x1b[I');await ui.flush();
  const quiet=ui.controller.revision;await key('z','z');assert.equal(ui.controller.revision,quiet);assert.equal(!!ui.view.busy,false);
  for(const[name,char]of[['/','/'],['?','?'],['f1','']] as const){
    await key(name,char);assert.equal(ui.view.screen,'menu');await key('escape');
  }
  assert.equal(terminal.read().includes('正在处理'),false);
  const openMore=async(index:number)=>{await key('/','/');for(let i=0;i<index;i++)await key('down');await key('return');};
  await openMore(2);assert.equal(ui.view.screen,'manage');await key('escape');assert.equal(ui.view.screen,'menu');await key('escape');
  const beforeTheme=requests.length;
  await key('v','v');assert.equal(store.state.settings.colorTheme,'acid');
  await key('v','v');assert.equal(store.state.settings.colorTheme,'astolfo');
  await key('v','v');assert.equal(store.state.settings.colorTheme,'spectrum');
  await key('v','v');assert.equal(store.state.settings.colorTheme,'mescaline');assert.equal(requests.length,beforeTheme);
  await key('x','x');assert.equal(store.state.settings.privacyMode,true);
  await key('x','x');assert.equal(store.state.settings.privacyMode,false);assert.equal(requests.length,beforeTheme);
  await openMore(5);assert.equal(ui.view.screen,'appearance');
  await key('down');await key('right');assert.equal(store.state.settings.logoFont,'plain');
  await key('return');assert.equal(ui.view.screen,'fonts');
  await key('pagedown');await key('end');await key('home');
  ui.controller.handle('/',{name:'/'});assert.equal(ui.view.form?.title,'查找字标');
  ui.controller.handle('The Edge',{});await key('return');
  assert.equal(ui.view.fontQuery,'The Edge');await key('return');
  assert.equal(ui.view.screen,'appearance');assert.equal(store.state.settings.logoFont,'figlet:The Edge');
  await key('down');await key('right');assert.equal(store.state.settings.visualStyle,'spiral');
  await key('down');await key('right');assert.equal(store.state.settings.visualOpacity,50);
  await key('left');assert.equal(store.state.settings.visualOpacity,35);

  await key('down');await key('right');assert.equal(store.state.settings.gradientSpeed,8);
  await key('escape');assert.equal(ui.view.screen,'menu');await key('escape');assert.equal(ui.view.screen,'home');assert.equal(requests.length,beforeTheme);
  for(const[columns,rows]of[[232,62],[40,16],[118,38]]){
    stdout.columns=columns!;stdout.rows=rows!;stdout.emit('resize');
    await ui.flush();assert.equal(ui.controller.height,rows);
  }
  await openMore(1);assert.equal(ui.view.screen,'information');
  assert.equal(requests.length,beforeTheme);await key('r','r');assert.equal(requests.length,beforeTheme+4);
  await key('escape');assert.equal(ui.view.screen,'menu');await key('escape');
  await openMore(4);assert.equal(ui.view.screen,'school');
  assert.equal(requests.length,beforeTheme+4);await key('r','r');assert.equal(requests.length,beforeTheme+6);
  await key('2','2');assert.equal(ui.view.infoTab,1);
  await key('right');assert.equal(ui.view.infoTab,0);
  const beforeTab=requests.length;await key('tab');assert.equal(requests.length,beforeTab);await key('tab');
  await key('escape');assert.equal(ui.view.screen,'menu');await key('escape');assert.equal(ui.view.screen,'home');
  store.state.accounts[0]!.information!.fetchedAt=store.state.accounts[0]!.information!.schoolFetchedAt=Date.now()-30*24*3600_000;
  await openMore(1);assert.equal(requests.length,beforeTab);await key('escape');await key('escape');
  await openMore(4);assert.equal(requests.length,beforeTab);await key('escape');await key('escape');
  await key('return');await key('down');await key('return');assert.equal(ui.view.screen,'history');
  assert.equal(requests.length,beforeTab);await key('r','r');assert.equal(requests.length,beforeTab+1);
  const beforeOpen=requests.length;
  await key('return');assert.equal(ui.view.screen,'records');assert.ok(ui.view.lines?.includes('暂无详情缓存'));assert.equal(requests.length,beforeOpen);
  await key('r','r');assert.ok(ui.view.lines?.includes('轨迹点  461'));assert.equal(requests.length,beforeOpen+1);
  const beforeDetail=requests.length;await key('escape');await key('return');assert.equal(requests.length,beforeDetail);
  await key('escape');assert.equal(ui.view.screen,'history');
  await key('escape');assert.equal(ui.view.screen,'account');assert.equal(ui.view.selected,1);
  await key('return');assert.equal(ui.view.screen,'history');assert.equal(requests.length,beforeDetail);
  await key('escape');
  await key('escape');assert.equal(ui.view.screen,'home');
  const beforeUpdate=requests.length;await key('c','c');assert.equal(ui.view.screen,'home');assert.equal(requests.length,beforeUpdate+1);
  await key('q','q');await done;
  assert.equal(requests.some(p=>/login|issue|sportsId|inSportTime|savesports|upload/.test(p)),false);
  process.stdout.write(JSON.stringify({ok:true,title:'CGSCALINE',screens,requests:requests.length,login:0,renew:0,renderer:'native',frames:ui.frameCount,viewportSizes:['232x62','40x16','118x38']})+'\n');
}finally{await ui.controller.close();await done;terminal.dispose();}
