import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/runtime/storage.js';
import { Engine } from '../src/runtime/engine.js';
import { seedDemo, demoFetch } from '../src/core/demo.js';
import { frame, stripAnsi, cells } from '../src/render/theme.js';
import { artworkTail, dimArtwork } from '../src/render/backdrop.js';

test('背景模式铺满内容区域，文本保留且不同窗口不越界；素色、关闭与密码表单仍有效',async()=>{
  const store=new Store(null);await seedDemo(store);store.state.settings.visualStyle='spiral';
  for(const[w,h]of[[54,20],[118,38],[144,40],[232,62]])for(const color of[true,false]){
    const output=frame(store.state,{screen:'home',selected:1,notice:'',motion:3},w,h,color);
    const plain=stripAnsi(output),rows=plain.split('\n');assert.equal(rows.length,h);assert.ok(rows.every(row=>cells(row)===w!-1));
    for(const a of store.state.accounts)assert.ok(plain.includes(a.username));
    assert.ok(rows.some(row=>/[\u2801-\u28ff]/u.test(row.slice(0,Math.floor(w!*.45)))));
    if(!color)assert.equal(output.includes('\x1b'),false);
  }
  store.state.settings.visualStyle='none';assert.doesNotMatch(frame(store.state,{screen:'home',selected:0,notice:''},118,38,false),/[\u2801-\u28ff]/u);
  store.state.settings.visualStyle='spiral';
  const form=stripAnsi(frame(store.state,{screen:'home',selected:0,notice:'',form:{title:'登录',label:'密码',value:'private-value',secret:true}},118,38));
  assert.doesNotMatch(form,/private-value/);assert.match(form,/••/);assert.match(form,/[\u2801-\u28ff]/u);
  assert.doesNotMatch(form.split('\n').slice(-4).join('\n'),/[\u2801-\u28ff]/u);
});
test('图形裁切继承颜色，调暗后的色值仍合法',()=>{
  const row='\x1b[38;2;240;80;200m⣿⡇\x1b[38;2;40;160;255m⣷⣿';
  const tail=artworkTail(row,3);assert.equal(stripAnsi(tail),'⣿');assert.match(tail,/38;2;40;160;255m/);
  const dim=dimArtwork(row);assert.equal(stripAnsi(dim),stripAnsi(row));assert.notEqual(dim,row);
  for(const match of dim.matchAll(/38;2;(\d+);(\d+);(\d+)m/g))for(const v of match.slice(1))assert.ok(+v>=0&&+v<=255);
});
test('背景图形与新迷幻配色保存并重开后保留，不改动账号身份、设备、会话或任务',async()=>{
  const store=new Store(null);await seedDemo(store);const e=new Engine(store,demoFetch);await e.initialize();
  await e.queuePlan([store.state.accounts[0]!.id],Date.now()+60000,0);const before=JSON.stringify({accounts:store.state.accounts,tasks:store.state.tasks});
  await e.configureAppearance({visualStyle:'spiral',colorTheme:'mescaline'});assert.equal(JSON.stringify({accounts:store.state.accounts,tasks:store.state.tasks}),before);
  const reopened=new Store(null);reopened.state=structuredClone(store.state);await new Engine(reopened,demoFetch).initialize();assert.equal(reopened.state.settings.visualStyle,'spiral');assert.equal(reopened.state.settings.colorTheme,'mescaline');
  await assert.rejects(e.configureAppearance({visualStyle:'wire'} as never),/无效/);await e.shutdown();
});
