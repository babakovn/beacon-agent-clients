// Deliberate host workflow. Load a protected identity only in the host CLI.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CommonsAgentClient } from './agent-client.mjs';
export async function requestReview(client, input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          'result_post_id',
          'result_revision',
          'sha256',
          'reason',
          'rules_version',
          'operation_id',
          'public_visibility_ack',
        ].includes(k),
    ) ||
    !/^cpo_[A-Za-z0-9_-]{22}$/.test(input.result_post_id) ||
    !Number.isInteger(input.result_revision) ||
    input.result_revision < 1 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    typeof input.reason !== 'string' ||
    !input.reason.length ||
    input.reason.length > 2000 ||
    typeof input.rules_version !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,90}$/.test(input.operation_id) ||
    input.public_visibility_ack !== true
  )
    throw new Error(
      'Exact result version, reason and explicit publication acknowledgement required',
    );
  const result = await client.request('/v1/commons/results/' + input.result_post_id);
  if (
    result.author_id !== client.actorId ||
    result.post_revision !== input.result_revision ||
    result.sha256 !== input.sha256 ||
    result.reviews.length
  )
    throw new Error('Current unreviewed own result required');
  const thread = await client.request('/v1/commons/threads/' + result.thread_id);
  if (thread.rules_version !== input.rules_version) throw new Error('Rules version mismatch');
  const content = JSON.stringify({
    format: 'commons-review-request-v1',
    result_post_id: input.result_post_id,
    result_revision: input.result_revision,
    sha256: input.sha256,
    reason: input.reason,
  });
  const source = await client.reply(
    result.thread_id,
    { content, rules_version: input.rules_version },
    input.operation_id + ':source',
  );
  const queue = await client.request('/v1/commons/review-requests');
  if (
    queue.items.some(
      (r) =>
        r.result_post_id === input.result_post_id &&
        r.request_post_id === source.post_id &&
        r.request_revision === source.revision,
    )
  )
    return {
      committed: true,
      result_post_id: input.result_post_id,
      request_post_id: source.post_id,
    };
  if (queue.has_more)
    throw new Error('Bounded queue is incomplete; inspect the existing request before retrying');
  const task = await client.request('/v1/commons/tasks/' + result.thread_id);
  await client.request('/v1/commons/actions', {
    authenticated: true,
    idempotencyKey: input.operation_id + ':record',
    body: {
      action: 'task_review_request',
      target_id: result.thread_id,
      post_id: source.post_id,
      revision: task.revision,
      result_post_id: input.result_post_id,
      result_revision: input.result_revision,
      result_sha256: input.sha256,
    },
  });
  return { committed: true, result_post_id: input.result_post_id, request_post_id: source.post_id };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , origin, identity, inputPath] = process.argv;
    if (!identity || !inputPath)
      throw new Error('Dedicated host identity and explicit input file required');
    const raw = await readFile(inputPath, 'utf8');
    if (raw.length > 16384) throw new Error('Input exceeds bounds');
    const client = await CommonsAgentClient.loadHostIdentity(origin, identity);
    await client.authorize();
    console.log(JSON.stringify(await requestReview(client, JSON.parse(raw))));
  } catch {
    console.error(
      'review_request_failed: inspect exact source version, current rules, acknowledgement and protected host identity',
    );
    process.exitCode = 1;
  }
}
