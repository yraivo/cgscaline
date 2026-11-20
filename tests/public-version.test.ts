import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicVersionRequest } from '../src/campus/public-version.js';
import { parseVersion, Protocol } from '../src/protocol/index.js';
import { newAccount } from '../src/core/model.js';

test('公共更新请求使用公共签名固定向量，没有账号凭据和设备字段', () => {
  const request = publicVersionRequest('3.0.0', '21', 1793434382000);
  const url = new URL(request.url), headers = new Headers(request.headers);
  assert.equal(url.href.split('?')[0], 'https://tyapp.chingo.cn/cgapp/api/version');
  assert.equal(url.searchParams.get('app_key'), 'cgsoft');
  assert.equal(url.searchParams.get('timestamp'), '1793434382000');
  assert.equal(url.searchParams.get('sign'), '6ec078450e310e70c876adc36afe70d3');
  assert.equal(headers.get('app-key'), 'cgsoft');
  assert.deepEqual([...headers.keys()].sort(), ['accept','app-key']);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['app_key','schoolid','sign','systemType','timestamp','versionName']);
});

test('真实空 data 响应只在明确的未发现新版本消息下放行', () => {
  assert.equal(parseVersion('', '未发现新版本').status, 'ok');
  for (const message of [undefined, '', '参数错误', '发现新版本', '最新版本未知'])
    assert.equal(parseVersion('', message).status, 'unknown');
  assert.equal(parseVersion(undefined, '未发现新版本').status, 'unknown');
  assert.equal(parseVersion({ isForceUpdate: 1, content: 'upgrade' }, '未发现新版本').status, 'update');
});

test('公共检查确认业务码与 HTTP 状态，空响应不会覆盖错误状态', async () => {
  const a = newAccount('fake', 'placeholder1', '21');
  for (const [http, code, expected] of [[200,200,'ok'],[200,400,'unknown'],[503,200,'unknown']] as const) {
    const p = new Protocol(async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get('app_key'), 'cgsoft');
      assert.equal(new Headers(init?.headers).get('cgAuthorization'), null);
      return Response.json({ code, data:'', message:'未发现新版本' }, { status: http });
    });
    assert.equal((await p.check(a)).status, expected);
  }
});
