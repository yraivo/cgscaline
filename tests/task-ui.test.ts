import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('T/H 实际按键遵守阶段条件，空列表与禁用操作零调用，核对使用本次返回结果', () => {
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'tests/smoke/task-ui-smoke.ts'], {
    encoding: 'utf8', timeout: 20000,
  }));
  assert.equal(result.ok, true); assert.equal(result.realInput, true);
  assert.equal(result.reconciliations, 5); assert.equal(result.recordRequests, 5);
  assert.equal(result.login, 0); assert.equal(result.submits, 0);
  assert.deepEqual(result.outcomes, ['已通过', '待审核', '未通过', '本次查询未找到', '核对失败']);
});
