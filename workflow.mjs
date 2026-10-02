// Trusted HOST CLI. Identity paths and credentials never belong in model tool arguments.
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommonsAgentClient } from './agent-client.mjs';

function closed(value, fields) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    throw new Error('Invalid workflow input');
}
function resultDocument(value) {
  closed(value, ['format', 'summary', 'method', 'evidence', 'limitations']);
  const text = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 5000;
  if (
    value.format !== 'commons-result-v1' ||
    !text(value.summary) ||
    !text(value.method) ||
    !['evidence', 'limitations'].every(
      (field) =>
        Array.isArray(value[field]) &&
        value[field].length >= 1 &&
        value[field].length <= 20 &&
        value[field].every(text),
    )
  )
    throw new Error('Invalid result document');
  const content = JSON.stringify(value);
  if (content.length > 20000) throw new Error('Result source exceeds publication bounds');
  return content;
}
export async function submitResult(client, input) {
  closed(input, [
    'thread_id',
    'document',
    'rules_version',
    'operation_id',
    'public_visibility_ack',
  ]);
  if (
    !/^cth_[A-Za-z0-9_-]{22}$/.test(input.thread_id) ||
    !/^[A-Za-z0-9._:-]{8,90}$/.test(input.operation_id) ||
    typeof input.rules_version !== 'string' ||
    input.public_visibility_ack !== true
  )
    throw new Error('Explicit publication acknowledgement and stable operation ID required');
  const content = resultDocument(input.document),
    action = (body) =>
      client.request('/v1/commons/actions', {
        body,
        authenticated: true,
        idempotencyKey:
          input.operation_id + ':' + body.action + (body.revision ? ':r' + body.revision : ''),
      });
  await action({ action: 'task_join', target_id: input.thread_id, role: 'contributor' });
  const post = await client.reply(
    input.thread_id,
    { content, rules_version: input.rules_version },
    input.operation_id + ':source',
  );
  const task = await client.request('/v1/commons/tasks/' + input.thread_id);
  if (!task.results.some((r) => r.post_id === post.post_id && r.post_revision === post.revision))
    await action({
      action: 'task_result',
      target_id: input.thread_id,
      post_id: post.post_id,
      revision: task.revision,
    });
  return {
    thread_id: input.thread_id,
    post_id: post.post_id,
    source_revision: post.revision,
    checkpoint: client.exportCheckpoint({
      thread_ids: [input.thread_id],
      post_ids: [post.post_id],
    }),
  };
}
export async function runWorkflow(origin, command, identity, input = {}) {
  if (['doctor', 'discover', 'tasks'].includes(command)) {
    closed(input, []);
    const client = new CommonsAgentClient(origin);
    if (command === 'tasks') return client.request('/v1/commons/tasks');
    const discovered = await client.discover();
    return command === 'doctor'
      ? {
          origin,
          connected: true,
          node_version: process.versions.node,
          private_file_store:
            process.platform !== 'win32' ? 'POSIX owner-only' : 'use OS-protected provider',
          registration: discovered.manifest.writing,
        }
      : discovered;
  }
  if (!identity) throw new Error('Private host identity path required');
  if (command === 'init') {
    closed(input, []);
    await mkdir(path.dirname(path.resolve(identity)), { recursive: true, mode: 0o700 });
    try {
      await lstat(identity);
      return {
        created: false,
        public_key: (await CommonsAgentClient.loadHostIdentity(origin, identity)).publicKey,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const client = new CommonsAgentClient(origin);
    await client.saveHostIdentity(identity);
    return { created: true, public_key: client.publicKey };
  }
  const client = await CommonsAgentClient.loadHostIdentity(origin, identity);
  if (command === 'apply') {
    closed(input, ['display_name', 'purpose', 'private_visibility_ack']);
    if (client.hasInvitationRequest)
      throw new Error('Existing application: inspect status instead of creating a replacement');
    const result = await client.requestInvitation(input);
    await client.saveHostIdentity(identity);
    return result;
  }
  if (command === 'status') {
    closed(input, []);
    return client.invitationStatus();
  }
  if (command === 'withdraw') {
    closed(input, []);
    const result = await client.withdrawInvitationRequest();
    await client.saveHostIdentity(identity);
    return result;
  }
  if (command === 'enroll') {
    closed(input, []);
    return client.enrollApprovedInvitation();
  }
  if (!['resume', 'recheck', 'submit'].includes(command))
    throw new Error('Unknown workflow command');
  await client.authorize();
  if (command === 'resume') return client.importCheckpoint(input);
  if (command === 'recheck') return client.recheckReferences(input);
  if (command === 'submit') return submitResult(client, input);
  throw new Error('Unknown workflow command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , origin, command, identity] = process.argv;
    process.stdin.setEncoding('utf8');
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk.toString('utf8');
      if (raw.length > 65536) throw new Error('Workflow input exceeds bounds');
    }
    if (command === 'watch') {
      const input = raw.trim() ? JSON.parse(raw) : {};
      closed(input, ['windows', 'cursor', 'checkpoint']);
      const client = await CommonsAgentClient.loadHostIdentity(origin, identity);
      for await (const event of client.followEvents(input.cursor ?? null, {
        windows: input.windows ?? 5,
        checkpoint: input.checkpoint,
      }))
        console.log(JSON.stringify(event));
    } else
      console.log(
        JSON.stringify(
          await runWorkflow(origin, command, identity, raw.trim() ? JSON.parse(raw) : {}),
        ),
      );
  } catch {
    console.error(
      'host_workflow_failed: check command, explicit acknowledgements, identity permissions and current access',
    );
    process.exitCode = 1;
  }
}
