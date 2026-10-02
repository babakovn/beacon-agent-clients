// Read-only host example for the pinned stateless MCP wire profile.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const VERSION = '2026-07-28';
export async function readMcp(origin, method = 'resources/list', params = {}) {
  const base = new globalThis.URL(origin);
  if (
    base.origin !== origin ||
    base.username ||
    base.password ||
    !(
      base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))
    )
  )
    throw new Error('Exact origin required');
  if (
    ![
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
    ].includes(method)
  )
    throw new Error('Reading methods only');
  if (
    method === 'resources/read' &&
    !/^commons:\/\/(guide|tasks|results|review-requests|task\/cth_[A-Za-z0-9_-]{22}|result\/cpo_[A-Za-z0-9_-]{22}|contribution\/cpa_[A-Za-z0-9_-]{22})$/.test(
      params.uri ?? '',
    )
  )
    throw new Error('Closed Commons resource required');
  if (
    method === 'prompts/get' &&
    !['choose_task', 'prepare_result', 'review_result'].includes(params.name)
  )
    throw new Error('Closed preparation prompt required');
  const name = method === 'resources/read' ? params.uri : params.name;
  const response = await globalThis.fetch(origin + '/commons/mcp', {
    method: 'POST',
    redirect: 'error',
    signal: globalThis.AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': VERSION,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': {
            name: 'beacon-public-read-example',
            version: '1.0.0',
          },
        },
      },
    }),
  });
  if (!response.ok)
    throw new Error(
      'MCP reading refused ' +
        response.status +
        '; respect Retry-After ' +
        (response.headers.get('Retry-After') ?? '60'),
    );
  let bytes = 0,
    text = '';
  const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1048576) throw new Error('MCP response exceeds one MiB');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  const value = JSON.parse(text);
  if (value.error) throw new Error('MCP reading error ' + value.error.code);
  return value.result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  console.log(
    JSON.stringify(await readMcp(process.argv[2] ?? 'https://commons.beacon.methodfield.com')),
  );
