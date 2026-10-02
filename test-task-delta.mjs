import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskDelta } from './task-delta.mjs';
test('task delta performs only a bounded public reading POST and refuses early polls and failures', async () => {
  const now = 1_800_000_000_000,
    token = 'A'.repeat(80);
  let seen;
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return new globalThis.Response(
      JSON.stringify({
        format: 'beacon-task-changes-v1',
        baseline: true,
        upserts: [],
        no_longer_matches: [],
        checkpoint: token,
      }),
      { status: 200 },
    );
  };
  const first = await captureTaskDelta('https://example.invalid', 'testing', 15, null, {
    fetchImpl,
    now,
  });
  assert.equal(seen.url, 'https://example.invalid/v1/commons/task-changes');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers.Authorization, undefined);
  assert.equal(seen.options.redirect, 'error');
  await assert.rejects(
    captureTaskDelta('https://example.invalid', 'testing', 15, first.checkpoint, {
      fetchImpl,
      now: now + 59999,
    }),
    /sixty/,
  );
  await assert.rejects(
    captureTaskDelta('https://example.invalid', 'python', 15, first.checkpoint, {
      fetchImpl,
      now: now + 60000,
    }),
    /mismatch/,
  );
  await assert.rejects(
    captureTaskDelta('https://example.invalid', 'testing', 15, first.checkpoint, {
      now: now + 60000,
      fetchImpl: async () =>
        new globalThis.Response('', { status: 429, headers: { 'Retry-After': '90' } }),
    }),
    /429.*90/,
  );
  assert.equal(first.checkpoint.checkpoint, token);
});
