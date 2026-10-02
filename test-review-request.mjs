import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestReview } from './review-request.mjs';
const input = {
  result_post_id: 'cpo_' + 'A'.repeat(22),
  result_revision: 1,
  sha256: 'a'.repeat(64),
  reason: 'TEST reproduce one bounded observation',
  rules_version: 'TEST',
  operation_id: 'TEST-request-01',
  public_visibility_ack: true,
};
test('explicit request binds own exact result, retries without duplicating sources and never creates a peer claim', async () => {
  let committed = false,
    replies = 0,
    records = 0;
  const client = {
    actorId: 'cpa_' + 'A'.repeat(22),
    request: async (path, options) => {
      if (path.startsWith('/v1/commons/results/'))
        return {
          author_id: client.actorId,
          post_revision: 1,
          sha256: input.sha256,
          reviews: [],
          thread_id: 'cth_' + 'A'.repeat(22),
        };
      if (path.startsWith('/v1/commons/threads/')) return { rules_version: 'TEST' };
      if (path === '/v1/commons/review-requests')
        return {
          items: committed
            ? [
                {
                  result_post_id: input.result_post_id,
                  request_post_id: 'cpo_' + 'B'.repeat(22),
                  request_revision: 1,
                },
              ]
            : [],
          has_more: false,
        };
      if (path.startsWith('/v1/commons/tasks/')) return { revision: 2 };
      assert.equal(path, '/v1/commons/actions');
      assert.equal(options.body.action, 'task_review_request');
      assert.equal(options.body.result_revision, 1);
      assert.equal(options.body.result_sha256, input.sha256);
      assert.equal(options.authenticated, true);
      assert.equal(options.idempotencyKey, input.operation_id + ':record');
      records++;
      committed = true;
      return { committed: true };
    },
    reply: async (thread, body, key) => {
      assert.equal(key, input.operation_id + ':source');
      assert.equal(JSON.parse(body.content).format, 'commons-review-request-v1');
      replies++;
      return { post_id: 'cpo_' + 'B'.repeat(22), revision: 1 };
    },
  };
  const a = await requestReview(client, input),
    b = await requestReview(client, input);
  assert.deepEqual(a, b);
  assert.equal(records, 1);
  assert.equal(replies, 2); // The real reply operation reuses one server idempotency key.
  await assert.rejects(
    requestReview(client, { ...input, public_visibility_ack: false }),
    /acknowledgement/,
  );
  await assert.rejects(
    requestReview(client, { ...input, result_revision: 2 }),
    /Current unreviewed own result/,
  );
  assert.equal(records, 1);
  assert.equal(replies, 2);
});
