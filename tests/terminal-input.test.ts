import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalInput, type InputKey } from '../src/ui/input.js';

test('分包的焦点、F1、方向键与 UTF-8 不泄露为普通快捷键', () => {
  const keys: Array<{text: string; key: InputKey}> = [], focus: boolean[] = [];
  const input = new TerminalInput((text, key) => keys.push({text, key}), () => assert.fail('unexpected paste'), f => focus.push(f));
  try {
    for (const c of ['\x1b', '[', 'O', '\x1b[', 'I', '\x1b', 'O', 'P', '\x1b[', '11~', '\x1b[', 'P', '\x1b[', 'B', '?']) input.write(c);
    for (const byte of Buffer.from('中👟')) input.write(Buffer.from([byte]));
    assert.deepEqual(focus, [false, true]);
    assert.deepEqual(keys.map(k => k.key.name).slice(0, 4), ['f1', 'f1', 'f1', 'down']);
    assert.equal(keys.slice(4).map(k => k.text).join(''), '?中👟');
  } finally { input.dispose(); }
});

test('分包粘贴作为一条文本处理，内含回车和控制键不触发命令，输入长度有上限', () => {
  const keys: string[] = [], pastes: string[] = [];
  const input = new TerminalInput(text => keys.push(text), text => pastes.push(text), () => assert.fail('unexpected focus'));
  try {
    const payload = '秘密👩‍💻\r\x03\x1b[Oq';
    for (const byte of Buffer.from('\x1b[200~' + payload + '\x1b[201~?')) input.write(Buffer.from([byte]));
    assert.deepEqual(pastes, [payload]);
    assert.deepEqual(keys, ['?']);
    input.write('\x1b[200~' + 'x'.repeat(100_000));
    input.write('\x1b[201~');
    assert.equal(pastes[1]!.length, 2048);
  } finally { input.dispose(); }
});

test('单独 Esc 正常返回，销毁后取消未完成的转义定时器', async () => {
  const names: string[] = [];
  const input = new TerminalInput((_text, key) => names.push(key.name!), () => {}, () => {});
  input.write('\x1b');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(names, ['escape']);
  input.write('\x1b');
  input.dispose();
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(names, ['escape']);
});
