import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSubscription, diffSubscriptions } from './task-watch.mjs';
const data = JSON.parse(
  readFileSync(new globalThis.URL('./evaluation-fixture.json', import.meta.url), 'utf8'),
);
const { origin, now } = data;
const task = (letter, revision = 1) => ({
  thread_id: 'cth_' + letter.repeat(22),
  revision,
  title: 'TEST ' + letter,
  skills: ['testing'],
});
const fixture = (items) => async (url, options) => {
  assert(url.startsWith(origin + '/v1/commons/tasks?'));
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, undefined);
  return new globalThis.Response(JSON.stringify({ items, next_cursor: null }));
};
test('portable change fixture distinguishes first baseline, actual edits and absence without executing content', async () => {
  const first = await captureSubscription(origin, 'testing', 15, null, {
    now,
    fetchImpl: fixture(data.before),
    pace: false,
  });
  assert.equal(first.changes.first_check, true);
  assert.equal(first.changes.added.length, data.expected.first_baseline);
  const next = await captureSubscription(origin, 'testing', 15, first.snapshot, {
    now: now + 60000,
    fetchImpl: fixture(data.after),
    pace: false,
  });
  assert.deepEqual(
    next.changes.added.map((t) => t.thread_id),
    data.expected.added,
  );
  assert.deepEqual(
    next.changes.changed.map((t) => t.thread_id),
    data.expected.changed,
  );
  assert.deepEqual(
    next.changes.no_longer_matches.map((t) => t.thread_id),
    data.expected.no_longer_matches,
  );
  assert.equal(
    diffSubscriptions({ ...first.snapshot, complete: false }, next.snapshot).no_longer_matches
      .length,
    0,
  );
  await assert.rejects(
    captureSubscription(origin, 'testing', 15, first.snapshot, {
      now: now + 59999,
      fetchImpl: () => {
        throw new Error('must not fetch');
      },
    }),
    /sixty seconds/,
  );
  await assert.rejects(
    captureSubscription(origin, 'python', 15, first.snapshot, {
      now: now + 60000,
      fetchImpl: () => {
        throw new Error('must not fetch');
      },
    }),
    /mismatch/,
  );
});
test('partial bounded scans, refusals and invalid pages cannot manufacture removals', async () => {
  let calls = 0;
  const cursor = 'A'.repeat(40);
  const partial = await captureSubscription(origin, 'testing', 15, null, {
    now,
    pace: false,
    fetchImpl: async () =>
      new globalThis.Response(
        JSON.stringify({ items: [task(String.fromCharCode(65 + calls++))], next_cursor: cursor }),
      ),
  });
  assert.equal(calls, 4);
  assert.equal(partial.snapshot.complete, false);
  const refused = async () =>
    new globalThis.Response('{}', { status: 429, headers: { 'Retry-After': '120' } });
  await assert.rejects(
    captureSubscription(origin, 'testing', 15, null, { now, fetchImpl: refused }),
    /Retry-After 120/,
  );
  await assert.rejects(
    captureSubscription(origin, 'testing', 15, null, {
      now,
      fetchImpl: fixture([{ thread_id: 'https://attacker.example/script', revision: 1 }]),
    }),
    /Invalid bounded task reference/,
  );
});
