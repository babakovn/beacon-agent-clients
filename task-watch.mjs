// Host-managed skill subscription. Public reads only; no identity or publication.
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const SKILLS = [
  'research',
  'testing',
  'python',
  'nodejs',
  'writing',
  'data-analysis',
  'accessibility',
  'security',
  'benchmarking',
  'documentation',
  'review',
  'integration',
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function binding(origin, skill, maxMinutes) {
  const url = new globalThis.URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
    ) ||
    !SKILLS.includes(skill) ||
    !Number.isInteger(maxMinutes) ||
    maxMinutes < 5 ||
    maxMinutes > 10080
  )
    throw new Error('Exact origin and controlled task filters required');
  return { origin, skill, max_minutes: maxMinutes };
}
function checked(value) {
  if (
    !value ||
    value.format !== 'commons-skill-subscription-v1' ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > 200 ||
    Object.keys(value).some(
      (k) =>
        !['format', 'origin', 'skill', 'max_minutes', 'checked_at', 'complete', 'tasks'].includes(
          k,
        ),
    )
  )
    throw new Error('Invalid public subscription checkpoint');
  binding(value.origin, value.skill, value.max_minutes);
  const ids = new Set();
  for (const task of value.tasks) {
    if (
      !task ||
      !/^cth_[A-Za-z0-9_-]{22}$/.test(task.thread_id) ||
      !Number.isInteger(task.revision) ||
      task.revision < 1 ||
      !/^([a-f0-9]{64})$/.test(task.sha256) ||
      typeof task.title !== 'string' ||
      task.title.length > 300 ||
      Object.keys(task).some((k) => !['thread_id', 'revision', 'sha256', 'title'].includes(k)) ||
      ids.has(task.thread_id)
    )
      throw new Error('Invalid bounded task reference');
    ids.add(task.thread_id);
  }
  return value;
}
export function diffSubscriptions(previous, current) {
  checked(current);
  if (!previous)
    return {
      first_check: true,
      added: current.tasks,
      changed: [],
      no_longer_matches: [],
      complete: current.complete,
      meaning: 'First visible baseline, not newly created work. Re-read references before acting.',
    };
  checked(previous);
  if (
    hash(binding(previous.origin, previous.skill, previous.max_minutes)) !==
    hash(binding(current.origin, current.skill, current.max_minutes))
  )
    throw new Error('Subscription origin/filter mismatch');
  const old = new Map(previous.tasks.map((t) => [t.thread_id, t])),
    next = new Map(current.tasks.map((t) => [t.thread_id, t]));
  return {
    first_check: false,
    added: current.tasks.filter((t) => !old.has(t.thread_id)),
    changed: current.tasks.filter(
      (t) =>
        old.has(t.thread_id) &&
        (old.get(t.thread_id).sha256 !== t.sha256 || old.get(t.thread_id).revision !== t.revision),
    ),
    no_longer_matches:
      previous.complete && current.complete
        ? previous.tasks.filter((t) => !next.has(t.thread_id))
        : [],
    complete: previous.complete && current.complete,
    meaning:
      'Changes in this bounded public query since the saved check. No longer matching can mean edits, visibility or filter changes; it does not prove deletion. Partial scans never infer missing records. Re-read current sources.',
  };
}
export async function captureSubscription(
  origin,
  skill = 'testing',
  maxMinutes = 15,
  previous = null,
  { fetchImpl = globalThis.fetch, now = Date.now(), pace = true } = {},
) {
  const filters = binding(origin, skill, maxMinutes);
  if (previous) {
    checked(previous);
    if (hash(binding(previous.origin, previous.skill, previous.max_minutes)) !== hash(filters))
      throw new Error('Subscription origin/filter mismatch');
    if (now - Date.parse(previous.checked_at) < 60000)
      throw new Error('Wait at least sixty seconds between checks');
  }
  const tasks = [],
    seen = new Set();
  let cursor = null,
    complete = false;
  for (let page = 0; page < 4; page++) {
    if (page && pace) await new Promise((resolve) => globalThis.setTimeout(resolve, 1300));
    const query = new globalThis.URLSearchParams({
      skill,
      max_effort_minutes: String(maxMinutes),
      state: 'open',
      limit: '50',
      ...(cursor ? { cursor } : {}),
    });
    const response = await fetchImpl(origin + '/v1/commons/tasks?' + query, {
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(20000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok)
      throw new Error(
        'Public read refused ' +
          response.status +
          '; respect Retry-After ' +
          (response.headers.get('Retry-After') ?? '60'),
      );
    // Streaming bounds protect hosts even when Content-Length is absent.
    let bytes = 0,
      text = '',
      decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 1048576) throw new Error('Public page exceeds one MiB');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (
      !Array.isArray(data.items) ||
      data.items.length > 50 ||
      !(
        data.next_cursor === null ||
        (typeof data.next_cursor === 'string' && /^[A-Za-z0-9_-]{40,2048}$/.test(data.next_cursor))
      )
    )
      throw new Error('Invalid bounded task page');
    for (const task of data.items) {
      if (seen.has(task.thread_id))
        throw new Error('Unstable repeated task page; retain the prior checkpoint');
      seen.add(task.thread_id);
      tasks.push({
        thread_id: task.thread_id,
        revision: task.revision,
        sha256: hash(task),
        title: typeof task.title === 'string' ? task.title.slice(0, 300) : '',
      });
    }
    cursor = data.next_cursor;
    if (cursor === null) {
      complete = true;
      break;
    }
  }
  const snapshot = checked({
    format: 'commons-skill-subscription-v1',
    ...filters,
    checked_at: new Date(now).toISOString(),
    complete,
    tasks,
  });
  return { snapshot, changes: diffSubscriptions(previous, snapshot) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [, , origin, skill = 'testing', minutes = '15', file] = process.argv;
    if (!file) throw new Error('A dedicated host checkpoint path is required');
    let previous = null;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 131072)
        throw new Error('Invalid checkpoint file');
      previous = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = await captureSubscription(origin, skill, Number(minutes), previous);
    await mkdir(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    const temp = file + '.new';
    await writeFile(temp, JSON.stringify(result.snapshot, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temp, file);
    console.log(JSON.stringify(result.changes));
  } catch (error) {
    console.error('subscription_failed: ' + error.message);
    process.exitCode = 1;
  }
}
