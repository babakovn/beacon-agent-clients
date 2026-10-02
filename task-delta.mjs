// Public read-only POST. A query-bound server checkpoint avoids downloading unchanged task rows.
import { readFile, writeFile, rename, lstat, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const skills = [
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
function filters(origin, skill, maxMinutes) {
  const url = new globalThis.URL(origin);
  if (
    url.origin !== origin ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    ) ||
    !skills.includes(skill) ||
    !Number.isInteger(maxMinutes) ||
    maxMinutes < 5 ||
    maxMinutes > 10080
  )
    throw new Error('Exact origin and controlled filters required');
  return { origin, skill, maxMinutes };
}
function checked(value, binding) {
  if (
    !value ||
    value.format !== 'commons-task-delta-host-v1' ||
    JSON.stringify(value.binding) !== JSON.stringify(binding) ||
    !Number.isFinite(Date.parse(value.checked_at)) ||
    !/^[A-Za-z0-9_-]{40,65536}$/.test(value.checkpoint)
  )
    throw new Error('Invalid checkpoint or origin/filter mismatch');
}
export async function captureTaskDelta(
  origin,
  skill,
  maxMinutes,
  previous = null,
  { fetchImpl = globalThis.fetch, now = Date.now() } = {},
) {
  const binding = filters(origin, skill, maxMinutes);
  if (previous) {
    checked(previous, binding);
    if (now - Date.parse(previous.checked_at) < 60000)
      throw new Error('Wait at least sixty seconds');
  }
  const response = await fetchImpl(origin + '/v1/commons/task-changes', {
    method: 'POST',
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      skill,
      max_effort_minutes: maxMinutes,
      state: 'open',
      ...(previous ? { since: previous.checkpoint } : {}),
    }),
  });
  if (!response.ok)
    throw new Error(
      'Public read refused ' +
        response.status +
        '; keep checkpoint and respect Retry-After ' +
        (response.headers.get('Retry-After') ?? '60'),
    );
  let bytes = 0,
    text = '';
  const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1048576) throw new Error('Response exceeds one MiB');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const data = JSON.parse(text),
    id = /^cth_[A-Za-z0-9_-]{22}$/;
  if (
    data.format !== 'beacon-task-changes-v1' ||
    data.baseline !== !previous ||
    !Array.isArray(data.upserts) ||
    data.upserts.length > 200 ||
    !Array.isArray(data.no_longer_matches) ||
    data.no_longer_matches.length > 200 ||
    !data.no_longer_matches.every((x) => id.test(x)) ||
    !data.upserts.every(
      (x) =>
        id.test(x.thread_id) &&
        typeof x.title === 'string' &&
        x.title.length <= 240 &&
        Number.isInteger(x.revision) &&
        x.revision > 0 &&
        /^[a-f0-9]{64}$/.test(x.fingerprint),
    ) ||
    new Set(data.upserts.map((x) => x.thread_id)).size !== data.upserts.length ||
    new Set(data.no_longer_matches).size !== data.no_longer_matches.length ||
    data.upserts.some((x) => data.no_longer_matches.includes(x.thread_id)) ||
    (data.baseline && data.no_longer_matches.length)
  )
    throw new Error('Invalid bounded change response');
  const checkpoint = {
    format: 'commons-task-delta-host-v1',
    binding,
    checked_at: new Date(now).toISOString(),
    checkpoint: data.checkpoint,
  };
  checked(checkpoint, binding);
  return {
    checkpoint,
    summary: {
      baseline: data.baseline,
      upserts: data.upserts,
      no_longer_matches: data.no_longer_matches,
      meaning:
        'Current differences, not every intervening event. Missing can mean visibility or filter changes. Re-read before acting.',
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [origin, skill, max, pathArg] = process.argv.slice(2);
  if (!pathArg)
    throw new Error('Usage: node task-delta.mjs ORIGIN SKILL MAX_MINUTES CHECKPOINT_FILE');
  const target = path.resolve(pathArg);
  let previous = null;
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000)
      throw new Error('Regular bounded checkpoint file required');
    previous = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await captureTaskDelta(origin, skill, Number(max), previous);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + process.pid + '.new';
  await writeFile(temporary, JSON.stringify(result.checkpoint, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, target);
  console.log(JSON.stringify(result.summary, null, 2));
}
