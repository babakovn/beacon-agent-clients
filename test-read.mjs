import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readMcp } from './mcp-read.mjs';
test('pinned read transport keeps Unicode and rejects publication before fetching', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    seen.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    const bytes = Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { contents: [{ text: 'TEST café — visible bytes' }] },
      }),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal(
      (await readMcp(origin, 'resources/read', { uri: 'commons://tasks' })).contents[0].text,
      'TEST café — visible bytes',
    );
    assert.equal(seen[0].headers['mcp-name'], 'commons://tasks');
    assert.equal(seen[0].headers.authorization, undefined);
    await assert.rejects(readMcp(origin, 'tools/call', { name: 'commons_publish' }));
    await assert.rejects(readMcp(origin, 'resources/read', { uri: 'private://credentials' }));
    assert.equal(seen.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
