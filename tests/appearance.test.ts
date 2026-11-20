import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { useColor } from '../src/render/appearance.js';
import { Store } from '../src/runtime/storage.js';
import { seedDemo } from '../src/core/demo.js';
import { cells, clip, frame, stripAnsi } from '../src/render/theme.js';
import {paletteColor,visualNames,wordmark,visualRenderers} from '../src/render/chroma.js';
import {filterFonts,isLogoFont,logoFonts,resolveGradientSpeed} from '../src/render/logo-fonts.js';
import {Engine} from '../src/runtime/engine.js';
import {identity,type LogoFont,type VisualStyle} from '../src/core/model.js';

test('显式霓虹覆盖继承 NO_COLOR，显式素色始终优先',()=>{
  assert.equal(useColor([],{NO_COLOR:'1'}),false);
  assert.equal(useColor(['--color'],{NO_COLOR:'1'}),true);
  assert.equal(useColor(['--color','--no-color'],{NO_COLOR:'1'}),false);
  assert.equal(useColor([],{FORCE_COLOR:'0'}),false);
});
test('字标与图形组合在不同窗口内完整重绘，关闭图形不绘制纹理，也没有装饰标签',async()=>{
  const store=new Store(null);await seedDemo(store);store.state.settings.colorTheme='astolfo';
  for(const font of ['plain','figlet:The Edge'] as LogoFont[])for(const visual of Object.keys(visualNames) as VisualStyle[]){
    store.state.settings.logoFont=font;store.state.settings.visualStyle=visual;
    for(const[w,h]of[[40,16],[118,38],[232,62]]){
      const text=stripAnsi(frame(store.state,{screen:'home',selected:0,notice:'',motion:3},w,h,true,true));
      assert.equal(text.split('\n').length,h);assert.ok(text.split('\n').every(row=>cells(row)===w!-1));
      assert.equal(text.includes('跑道示意'),false);assert.equal(text.includes('GPS'),false);
      if(visual==='none')assert.equal(/[\u2800-\u28ff]/u.test(text),false);
    }
  }
});
test('全部外观设置不更换设备、会话或已计划任务，未知预设不改写配置',async()=>{
  const store=new Store(null);await seedDemo(store);store.state.settings.colorTheme='astolfo';let requests=0;
  const e=new Engine(store,async()=>{requests++;throw Error('unexpected');});await e.initialize();const a=store.state.accounts[0]!;
  await e.queuePlan([a.id],Date.now()+60_000,0);const before=JSON.stringify({a,tasks:store.state.tasks}),id=identity(a);
  await e.configureAppearance({colorTheme:'spectrum',logoFont:'figlet:The Edge',visualStyle:'spiral',gradientSpeed:8,motion:false});
  assert.equal(requests,0);assert.equal(JSON.stringify({a,tasks:store.state.tasks}),before);assert.equal(identity(a),id);
  const settings=JSON.stringify(store.state.settings);await assert.rejects(e.configureAppearance({visualStyle:'external-code'} as never),/无效/);
  await assert.rejects(e.configureAppearance({logoFont:'figlet:../../private'} as never),/无效/);
  await assert.rejects(e.configureAppearance({gradientSpeed:NaN}),/无效/);
  assert.equal(JSON.stringify(store.state.settings),settings);
  const restored=new Store(null);restored.state=structuredClone(store.state);await new Engine(restored,async()=>{requests++;throw Error('unexpected');}).initialize();
  assert.equal(restored.state.settings.logoFont,'figlet:The Edge');assert.equal(restored.state.settings.gradientSpeed,8);assert.equal(restored.state.settings.visualStyle,'spiral');assert.equal(restored.state.settings.motion,false);assert.equal(requests,0);
});

test('全部随包字体能离线渲染，筛选不加载外部路径，超大字体保留操作区域',async()=>{
  assert.equal(logoFonts.length,2);assert.deepEqual(filterFonts('the edge'),['figlet:The Edge']);
  assert.equal(isLogoFont('figlet:../../secret'),false);assert.equal(isLogoFont('__proto__'),false);
  const dimensions=logoFonts.map(font=>{const rows=wordmark(0,false,'astolfo',font);assert.ok(rows.length>0);assert.equal(rows.join('').includes('\x1b'),false);return{font,width:Math.max(...rows.map(cells)),height:rows.length};});
  const widest=[...dimensions].sort((a,b)=>b.width-a.width)[0]!,tallest=[...dimensions].sort((a,b)=>b.height-a.height)[0]!;
  const s=new Store(null);await seedDemo(s);
  for(const font of [widest.font,tallest.font,'figlet:The Edge'] as LogoFont[]){
    s.state.settings.logoFont=font;
    for(const[w,h]of[[40,16],[80,24],[118,38],[232,62]])for(const screen of ['home','fonts'] as const){
      const text=stripAnsi(frame(s.state,{screen,selected:logoFonts.indexOf(font),notice:''},w,h,false)),rows=text.split('\n');
      assert.equal(rows.length,h);assert.ok(rows.every(row=>cells(row)===w!-1));assert.match(text,screen==='home'?/Q 关闭/:/Enter 保存/);
    }
  }
});

test('渐变默认四倍并可调，色相相位不改变图形运动几何',()=>{
  assert.equal(resolveGradientSpeed(undefined),4);assert.equal(resolveGradientSpeed(.5),.5);assert.equal(resolveGradientSpeed(Infinity),4);
  for(const visual of ['track','spiral'] as const){
    const render=visualRenderers[visual],slow=render(50,16,2,true,'spectrum',2),fast=render(50,16,2,true,'spectrum',16);
    assert.notDeepEqual(slow,fast);assert.deepEqual(slow.map(stripAnsi),fast.map(stripAnsi));
  }
});

test('跑道与螺旋按视口生成八点子格细节，放大增加采样且没有半格马赛克',()=>{
  for(const style of ['track','spiral'] as const){
    let previous=0;
    for(const[w,h]of[[1,1],[48,24],[116,52]]){
      const rows=visualRenderers[style](w!,h!,3,true,'spectrum',12).map(stripAnsi);
      assert.equal(rows.length,h);assert.ok(rows.every(row=>cells(row)===w));assert.equal(rows.join('').includes('▀'),false);
      const visible=rows.join('').replace(/ /g,'').length;assert.ok(visible>=previous);previous=visible;
      if(w!>1){assert.match(rows.join(''),/[\u2801-\u28ff]/u);assert.ok(visible>w!*h!*.15);}
    }
    assert.deepEqual(visualRenderers[style](0,24,3,true,'astolfo'),[]);
    const quiet=visualRenderers[style](64,32,0,true,'astolfo',0);assert.deepEqual(quiet,visualRenderers[style](64,32,0,true,'astolfo',0));
    assert.notDeepEqual(quiet,visualRenderers[style](64,32,.25,true,'astolfo',1));
  }
});

test('艺术区域随大窗口扩展；单格快速裁切不破坏中文、组合字符或 emoji',async()=>{
  const store=new Store(null);await seedDemo(store);store.state.settings.colorTheme='astolfo';store.state.settings.visualStyle='spiral';
  const rows=stripAnsi(frame(store.state,{screen:'home',selected:0,notice:'',motion:3},232,62,false,true)).split('\n');
  const occupied=rows.map((row,i)=>/[\u2801-\u28ff]/u.test(row)?i:-1).filter(i=>i>=0);
  assert.ok(occupied.at(-1)!-occupied[0]!>40);
  const art=rows.flatMap(row=>[...row].map((c,i)=>/[\u2801-\u28ff]/u.test(c)?i:-1).filter(i=>i>=0));
  assert.ok(Math.max(...art)-Math.min(...art)>76);
  assert.equal(cells('⣷⣿─█'),4);assert.equal(stripAnsi(clip('\x1b[38;2;255;0;0m⣷⣿ABC',2)),'⣷⣿');
  assert.equal(cells('☀️中e\u0301'),5);assert.equal(stripAnsi(clip('⣿中e\u0301',3)),'⣿中');
});

test('真实 CLI 在 NO_COLOR=1 的进程中也能按 --color 输出彩色，--no-color 能覆盖',()=>{
  const run=(extra:string[])=>execFileSync(process.execPath,['--import','tsx','src/cli.ts','--demo','--preview',...extra],{cwd:process.cwd(),env:{...process.env,NO_COLOR:'1'},encoding:'utf8'});
  const colorful=run(['--color']);assert.match(colorful,/\x1b\[38;2;/);assert.match(stripAnsi(colorful),/CGSCALINE/);
  assert.equal(run(['--color','--no-color']).includes('\x1b['),false);
});

test('全幅迷幻页面能滚动；小窗口密码表单仍完整可用且不泄露输入',async()=>{
  const s=new Store(null);await seedDemo(s);const a=s.state.accounts[0]!;
  const large=frame(s.state,{screen:'home',selected:0,motion:3,notice:''},144,40,true,true);
  assert.match(stripAnsi(large),/CGSCALINE/);assert.match(stripAnsi(large),new RegExp(a.username));
  for(const filler of['SOMA','CHROMA','OVERDRIVE','EXIT REALITY','一次配置','配置后','╭','╮','╰','╯'])assert.equal(stripAnsi(large).includes(filler),false);
  assert.notEqual(large,frame(s.state,{screen:'home',selected:0,motion:5,notice:''},144,40,true,true));
  a.proxy='http://fake-user:fake-proxy-password@localhost:7890';
  const manage=stripAnsi(frame(s.state,{screen:'manage',accountId:a.id,selected:4,notice:''},118,34,true));
  assert.match(manage,/http:\/\/localhost:7890/);assert.equal(manage.includes('fake-proxy-password'),false);
  for(const secret of [a.session!.token,a.session!.secret])assert.equal(manage.includes(secret),false);
  const small=stripAnsi(frame(s.state,{screen:'account',accountId:a.id,selected:0,notice:'',form:{title:'LOGIN',label:'密码只在本机输入',value:'fake-private-password',secret:true}},40,16,true));
  assert.equal(small.split('\n').length,16);assert.match(small,/LOGIN/);assert.match(small,/••/);assert.match(small,/Enter/);
  assert.equal(small.includes('fake-private-password'),false);assert.ok(small.split('\n').every(row=>cells(row)<40));
});

test('最大化与缩小使用完整视口，长列表和小窗口表单保留关键操作',async()=>{
  const s=new Store(null);await seedDemo(s);const a=s.state.accounts[0]!;
  for(const[width,height]of[[232,66],[188,48],[118,38],[54,20],[40,16],[24,9],[18,6]]){
    const output=stripAnsi(frame(s.state,{screen:'home',selected:0,notice:''},width,height,true,true));
    assert.equal(output.split('\n').length,height);assert.ok(output.split('\n').every(row=>cells(row)===width!-1));
    if(width!>=24)assert.match(output,new RegExp(a.username));
  }
  const compact=stripAnsi(frame(s.state,{screen:'account',accountId:a.id,selected:0,notice:'',form:{title:'LOGIN',label:'很长的确认提示'.repeat(12),value:'private-value',secret:true}},32,9));
  assert.match(compact,/LOGIN/);assert.match(compact,/••/);assert.match(compact,/Enter/);assert.match(compact,/Esc/);assert.equal(compact.includes('private-value'),false);
  assert.equal(cells('中😵‍💫e\u0301'),5);assert.equal(cells('a🇨🇳'),3);
});
test('隔离进程跑通真实 UI 的缩放、概览切页、记录详情与返回，不发送认证或运动写入',()=>{
  const result=JSON.parse(execFileSync(process.execPath,['--import','tsx','tests/smoke/ui-smoke.ts'],{encoding:'utf8',timeout:15_000}));
  assert.equal(result.ok,true);assert.equal(result.title,'CGSCALINE');assert.equal(result.login,0);assert.equal(result.renew,0);
  assert.equal(result.renderer,'native');assert.ok(result.frames>0);
  assert.ok(result.screens.includes('information'));assert.ok(result.screens.includes('history'));assert.ok(result.screens.includes('records'));
});
test('Astolfo 不经过绿色，主页使用跑道和单行满宽分隔线，快捷键不拆字',async()=>{
  for(let i=0;i<=100;i++){const[r,g,b]=paletteColor('astolfo',i/100);assert.ok(g<=Math.max(r,b));}
  const store=new Store(null);await seedDemo(store);store.state.settings.colorTheme='astolfo';
  const text=stripAnsi(frame(store.state,{screen:'home',selected:0,motion:2,notice:''},118,38,true,true)),rows=text.split('\n');
  assert.equal(text.includes('跑道示意'),false);assert.equal(text.includes('GPS'),false);assert.equal(text.includes('[C 检查]'),false);assert.equal(text.includes('[C]'),false);
  const separators=rows.filter(row=>/^─+$/.test(row));assert.equal(separators.length,1);assert.equal(cells(separators[0]!),117);
  assert.ok(rows.some(row=>row.includes('Q 关闭')));assert.ok(rows.some(row=>row.includes('/ 更多')));
  const colors=[...frame(store.state,{screen:'home',selected:0,notice:''},118,38,true,true).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
  assert.ok(colors.every(c=>Number(c[2])<=Math.max(Number(c[1]),Number(c[3]))));
});
