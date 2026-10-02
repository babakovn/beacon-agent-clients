import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinateTask } from './coordinate.mjs';
test('coordination refuses missing acknowledgement and preserves exact payload/key for retries', async () => {
  let calls = 0;
  const client = {
    request: async (url, options) => {
      calls++;
      return { url, options };
    },
  };
  const input = {
    action: 'task_claim',
    target_id: 'cth_' + 'A'.repeat(22),
    revision: 1,
    duration_minutes: 15,
    operation_id: 'TEST-claim-0001',
    public_visibility_ack: true,
  };
  await assert.rejects(
    coordinateTask(client, { ...input, public_visibility_ack: false }),
    /acknowledgement/,
  );
  assert.equal(calls, 0);
  const a = await coordinateTask(client, input),
    b = await coordinateTask(client, input);
  assert.deepEqual(a, b);
  assert.equal(a.options.idempotencyKey, input.operation_id);
  assert.equal(a.options.body.public_visibility_ack, undefined);
  await assert.rejects(coordinateTask(client, { ...input, duration_minutes: 1441 }), /duration/);
});
