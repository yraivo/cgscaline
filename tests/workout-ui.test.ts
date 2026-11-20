import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('实际按键与页脚一致：预览本地重生成，列表和详情仅按 R 请求，空数据和高级状态匹配', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tests/smoke/workout-ui-smoke.ts'], {
    encoding: 'utf8', timeout: 20000,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.realInput, true);
  assert.equal(result.listRequests, 3);
  assert.equal(result.detailRequests, 3);
  assert.equal(result.otherRequests, 0);
  assert.equal(result.tasks, 0);
  assert.ok(result.prepares >= 5);
});
