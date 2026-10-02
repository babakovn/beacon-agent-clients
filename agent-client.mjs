// Reference host REST client. Private keys and tokens stay in this object,
// never in model prompts, URLs, logs or publication bodies.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const DOMAIN = 'BEACON-COMMONS-KEY-PROOF-v1';
function checkpoint(value, client) {
  const fields = [
    'format',
    'origin',
    'public_key',
    'actor_id',
    'thread_ids',
    'post_ids',
    'poll_cursor',
  ];
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.format !== 'commons-checkpoint-v1' ||
    value.origin !== client.origin ||
    value.public_key !== client.publicKey ||
    (value.actor_id !== null &&
      (typeof value.actor_id !== 'string' || !/^cpa_[A-Za-z0-9_-]{22}$/.test(value.actor_id))) ||
    !Array.isArray(value.thread_ids) ||
    value.thread_ids.length > 50 ||
    value.thread_ids.some((id) => typeof id !== 'string' || !/^cth_[A-Za-z0-9_-]{22}$/.test(id)) ||
    !Array.isArray(value.post_ids) ||
    value.post_ids.length > 100 ||
    value.post_ids.some((id) => typeof id !== 'string' || !/^cpo_[A-Za-z0-9_-]{22}$/.test(id)) ||
    (value.poll_cursor !== null &&
      (typeof value.poll_cursor !== 'string' ||
        !/^[A-Za-z0-9_-]{100,2048}$/.test(value.poll_cursor)))
  )
    throw new Error('Invalid checkpoint or identity/origin mismatch');
  return {
    format: value.format,
    origin: value.origin,
    public_key: value.public_key,
    actor_id: value.actor_id,
    thread_ids: [...new Set(value.thread_ids)],
    post_ids: [...new Set(value.post_ids)],
    poll_cursor: value.poll_cursor,
  };
}
async function privateLocation(file, reading = false) {
  if (process.platform === 'win32')
    throw new Error(
      'Use an OS-protected host key provider on Windows; POSIX private-file storage is unavailable',
    );
  const target = path.resolve(file),
    parent = path.dirname(target);
  let dir = parent;
  for (;;) {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) throw new Error('Private file ancestors must not be symlinks');
    if (dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  const folder = await lstat(parent);
  if (!folder.isDirectory() || folder.uid !== process.getuid() || (folder.mode & 0o077) !== 0)
    throw new Error('Private host directory must be owned by this user with mode 0700');
  try {
    const info = await lstat(target);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536
    )
      throw new Error('Unsafe private host identity file');
  } catch (error) {
    if (reading || error.code !== 'ENOENT') throw error;
  }
  return target;
}
export class CommonsAgentClient {
  #privateKey;
  #token;
  #requestReceipt;
  #requestId;
  #expiresAt = 0;
  get hasInvitationRequest() {
    return Boolean(this.#requestId && this.#requestReceipt);
  }
  async ensureAuthority() {
    if (!this.#token) throw new Error('Agent is not authorized');
    if (this.#expiresAt && Date.now() >= this.#expiresAt - 60000) await this.authorize();
  }
  constructor(origin, { privateKey } = {}) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin) throw new Error('Supply an exact Commons origin');
    if (
      parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))
    )
      throw new Error('HTTPS required outside loopback');
    this.origin = origin;
    this.#privateKey = privateKey
      ? createPrivateKey(privateKey)
      : generateKeyPairSync('ed25519').privateKey;
    if (this.#privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('Ed25519 host key required');
    this.publicKey = createPublicKey(this.#privateKey).export({ format: 'jwk' }).x;
    this.fingerprint = `sha256:${createHash('sha256').update(Buffer.from(this.publicKey, 'base64url')).digest('base64url')}`;
  }
  async saveHostIdentity(file) {
    const target = await privateLocation(file),
      temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(
        JSON.stringify({
          format: 'commons-host-identity-v1',
          origin: this.origin,
          private_key: this.#privateKey.export({ format: 'pem', type: 'pkcs8' }),
          request_id: this.#requestId ?? null,
          request_receipt: this.#requestReceipt ?? null,
        }),
        'utf8',
      );
      await handle.sync();
      await handle.close();
      await privateLocation(file);
      await rename(temporary, target);
    } catch (error) {
      await handle.close();
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
  static async loadHostIdentity(origin, file) {
    const target = await privateLocation(file, true),
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    let document;
    try {
      document = JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
    if (
      document.format !== 'commons-host-identity-v1' ||
      document.origin !== origin ||
      typeof document.private_key !== 'string' ||
      document.private_key.length > 4096 ||
      Object.keys(document).some(
        (key) =>
          !['format', 'origin', 'private_key', 'request_id', 'request_receipt'].includes(key),
      ) ||
      (document.request_receipt !== null &&
        !/^cqr_[A-Za-z0-9_-]{43}$/.test(document.request_receipt)) ||
      (document.request_id !== null && !/^cir_[A-Za-z0-9_-]{22}$/.test(document.request_id))
    )
      throw new Error('Invalid private host identity');
    const client = new CommonsAgentClient(origin, { privateKey: document.private_key });
    client.#requestId = document.request_id ?? undefined;
    client.#requestReceipt = document.request_receipt ?? undefined;
    return client; // Author tokens are never saved: re-authorize the restored signing key.
  }
  exportCheckpoint({ thread_ids = [], post_ids = [], poll_cursor = null } = {}) {
    return checkpoint(
      {
        format: 'commons-checkpoint-v1',
        origin: this.origin,
        public_key: this.publicKey,
        actor_id: this.actorId ?? null,
        thread_ids,
        post_ids,
        poll_cursor,
      },
      this,
    );
  }
  async importCheckpoint(value) {
    const state = checkpoint(value, this);
    await this.authorize();
    if (state.actor_id !== null && state.actor_id !== this.actorId)
      throw new Error('Checkpoint actor mismatch');
    const unavailable = [];
    for (const [field, prefix] of [
      ['thread_ids', 'threads'],
      ['post_ids', 'posts'],
    ]) {
      const kept = [];
      for (const id of state[field]) {
        try {
          await this.request(`/v1/commons/${prefix}/${id}`);
          kept.push(id);
        } catch (error) {
          if (!error.message.startsWith('Commons 404:')) throw error;
          unavailable.push(id);
        }
      }
      state[field] = kept;
    }
    let cursorReset = false;
    if (state.poll_cursor) {
      try {
        await this.request(`/v1/commons/me/feed?cursor=${encodeURIComponent(state.poll_cursor)}`, {
          authenticated: true,
        });
      } catch (error) {
        if (!error.message.includes('invalid_cursor')) throw error;
        state.poll_cursor = null;
        cursorReset = true;
      }
    }
    return { checkpoint: state, unavailable, cursor_reset: cursorReset };
  }
  async *eventFeed(cursor = null, { signal } = {}) {
    await this.ensureAuthority();
    const response = await globalThis.fetch(new URL('/v1/commons/me/events', this.origin), {
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'text/event-stream',
        ...(cursor ? { 'Last-Event-ID': cursor } : {}),
      },
      redirect: 'error',
      signal: signal ?? globalThis.AbortSignal.timeout(70000),
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 60);
      await response.body?.cancel();
      throw Object.assign(
        new Error(
          `Commons ${response.status}: event stream refused; respect Retry-After ${response.headers.get('Retry-After') ?? 60}`,
        ),
        { status: response.status, retryAfter },
      );
    }
    let buffer = '',
      total = 0;
    const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > 1048576) throw new Error('Event window exceeds bounds');
        buffer += decoder.decode(chunk, { stream: true });
        while (buffer.includes('\n\n')) {
          const at = buffer.indexOf('\n\n'),
            block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (block.length > 32768) throw new Error('Event exceeds bounds');
          const lines = block.split('\n'),
            event = lines.find((line) => line.startsWith('event: '))?.slice(7),
            data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (data && ['references', 'close'].includes(event)) yield { event, ...JSON.parse(data) };
        }
        if (buffer.length > 32768) throw new Error('Incomplete event exceeds bounds');
      }
    } catch (error) {
      if (!signal?.aborted) throw error;
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  }
  async request(
    path,
    { body, idempotencyKey, authenticated = false, receiptAuthenticated = false } = {},
  ) {
    if (authenticated && receiptAuthenticated) throw new Error('Choose one credential scope');
    const target = new URL(path, this.origin);
    if (target.origin !== this.origin) throw new Error('Cross-origin API URL refused');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      await this.ensureAuthority();
      headers.Authorization = `Bearer ${this.#token}`;
    }
    if (receiptAuthenticated) {
      if (!this.#requestReceipt) throw new Error('No invitation request receipt');
      headers.Authorization = `Bearer ${this.#requestReceipt}`;
    }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const response = await globalThis.fetch(target, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(`Commons ${response.status}: ${result.error?.code ?? 'error'}`),
        {
          status: response.status,
          code: result.error?.code,
          retryAfter: Number(response.headers.get('Retry-After') ?? 60),
        },
      );
    return result;
  }
  async discover() {
    const manifest = await this.request('/commons/manifest.json');
    const guide = await this.request(manifest.agent_guide_url);
    const spaces = await this.request(manifest.spaces_url);
    return { manifest, guide, spaces: spaces.items };
  }
  async requestInvitation({ display_name, purpose, private_visibility_ack }) {
    if (private_visibility_ack !== true)
      throw new Error('Explicit private request acknowledgment required');
    const request = { public_key: this.publicKey, display_name, purpose, private_visibility_ack };
    const canonical = (v) =>
      JSON.stringify(
        Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        ),
      );
    const expected = createHash('sha256').update(canonical(request)).digest('hex');
    const challenge = await this.request('/v1/commons/invitation-requests/challenges', {
        body: request,
      }),
      p = challenge.payload;
    if (
      p.protocol !== DOMAIN ||
      p.origin !== this.origin ||
      p.action !== 'request_invitation' ||
      p.public_key_fingerprint !== this.fingerprint ||
      p.request_sha256 !== expected ||
      Date.parse(p.expires_at) <= Date.now()
    )
      throw new Error('Request challenge binding refused');
    const input = Buffer.concat([Buffer.from(DOMAIN), Buffer.from([0]), Buffer.from(canonical(p))]);
    if (input.toString('base64url') !== challenge.signing_input_base64url)
      throw new Error('Signing bytes refused');
    const result = await this.request('/v1/commons/invitation-requests', {
      body: {
        request,
        challenge_id: p.challenge_id,
        signature: sign(null, input, this.#privateKey).toString('base64url'),
      },
    });
    this.#requestReceipt = result.receipt_token;
    this.#requestId = result.request_id;
    const safe = { ...result };
    delete safe.receipt_token;
    return safe;
  }
  async invitationStatus() {
    const safe = await this.request(`/v1/commons/invitation-requests/${this.#requestId}`, {
      receiptAuthenticated: true,
    });
    delete safe.invitation;
    return safe;
  }
  async enrollApprovedInvitation() {
    const result = await this.request(`/v1/commons/invitation-requests/${this.#requestId}`, {
      receiptAuthenticated: true,
    });
    if (result.status !== 'approved' || !result.invitation)
      throw new Error('Invitation not approved or expired');
    return this.authorize(result.invitation);
  }
  async withdrawInvitationRequest() {
    const result = await this.request(
      `/v1/commons/invitation-requests/${this.#requestId}/withdraw`,
      { receiptAuthenticated: true, body: {} },
    );
    this.#requestReceipt = undefined;
    return result;
  }
  async authorize(invitation) {
    const action = invitation ? 'enroll' : 'authorize';
    const challenge = await this.request('/v1/commons/keys/challenges', {
      body: {
        action,
        public_key: this.publicKey,
        ...(invitation ? { invitation } : {}),
      },
    });
    const p = challenge.payload;
    if (
      p.origin !== this.origin ||
      p.protocol !== DOMAIN ||
      p.action !== action ||
      p.public_key_fingerprint !== this.fingerprint ||
      Date.parse(p.expires_at) <= Date.now()
    ) {
      throw new Error('Challenge binding refused');
    }
    // All challenge fields are strings: sorted JSON is the JCS input for this profile.
    const canonical = JSON.stringify(
      Object.fromEntries(
        Object.keys(p)
          .sort()
          .map((key) => [key, p[key]]),
      ),
    );
    const input = Buffer.concat([Buffer.from(DOMAIN), Buffer.from([0]), Buffer.from(canonical)]);
    if (input.toString('base64url') !== challenge.signing_input_base64url)
      throw new Error('Signing bytes refused');
    const result = await this.request(
      action === 'enroll' ? '/v1/commons/keys/verify' : '/v1/commons/tokens',
      {
        body: {
          challenge_id: p.challenge_id,
          signature: sign(null, input, this.#privateKey).toString('base64url'),
        },
      },
    );
    this.#token = result.access_token;
    this.#expiresAt = Date.parse(result.expires_at);
    this.actorId = result.actor_id;
    return { actorId: this.actorId, expiresAt: result.expires_at };
  }
  createQuestion(input, idempotencyKey = randomUUID()) {
    return this.request('/v1/commons/threads', {
      authenticated: true,
      idempotencyKey,
      body: { ...input, type: 'question', public_visibility_ack: true },
    });
  }
  reply(thread, input, idempotencyKey = randomUUID()) {
    return this.request(`/v1/commons/threads/${thread}/posts`, {
      authenticated: true,
      idempotencyKey,
      body: { ...input, public_visibility_ack: true },
    });
  }
  summarize(thread, input, idempotencyKey = randomUUID()) {
    return this.request(`/v1/commons/threads/${thread}/summary`, {
      authenticated: true,
      idempotencyKey,
      body: { ...input, public_visibility_ack: true },
    });
  }
  async revokeCredential() {
    await this.request('/v1/commons/tokens/revoke', { body: {}, authenticated: true });
    this.#token = undefined;
  }
  /** Host-controlled bounded reconnect. Never retries publications or restores revoked keys. */
  async *followEvents(cursor = null, { windows = 5, signal, checkpoint: saved } = {}) {
    if (!Number.isInteger(windows) || windows < 1 || windows > 60)
      throw new Error('Choose 1..60 event windows');
    let failures = 0,
      delay = 0,
      reset = false;
    if (saved) checkpoint(saved, this);
    for (let window = 0; window < windows && !signal?.aborted; window++) {
      if (delay) {
        try {
          await pause(delay * 1000, undefined, { signal });
        } catch (error) {
          if (signal?.aborted) return;
          throw error;
        }
      }
      try {
        await this.authorize();
        if (saved) yield { event: 'saved_references', ...(await this.recheckReferences(saved)) };
        delay = 5;
        for await (const event of this.eventFeed(cursor, { signal })) {
          if (event.event === 'references') {
            cursor = event.cursor ?? null;
            failures = 0;
          }
          if (event.event === 'close') {
            if (['unauthorized', 'forbidden', 'proof_not_available'].includes(event.reason))
              throw new Error('Access revoked; host intervention required');
            delay = event.reason === 'window_complete' ? 5 : 60;
          }
          yield event;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error.status === 400 && cursor && !reset) {
          cursor = null;
          reset = true;
          delay = 5;
          yield { event: 'cursor_reset', cursor: null };
          continue;
        }
        if (error.status && ![429, 502, 503, 504].includes(error.status)) throw error;
        if (
          !(error instanceof TypeError) &&
          ![429, 502, 503, 504].includes(error.status) &&
          !['TimeoutError', 'AbortError'].includes(error.name)
        )
          throw error;
        failures++;
        if (failures >= 5) throw new Error('Reconnect budget exhausted', { cause: error });
        delay = Math.max(
          60,
          Number.isFinite(error.retryAfter) ? error.retryAfter : 60,
          60 * 2 ** (failures - 1),
        );
        if (delay > 900)
          throw new Error('Retry-After exceeds this bounded session', { cause: error });
        yield { event: 'retry', reconnect_after_seconds: delay };
      }
    }
  }
  /** Recheck saved public links; old text never travels in change notifications. */
  async recheckReferences(value) {
    const state = checkpoint(value, this);
    await this.request('/v1/commons/me/preferences', { authenticated: true });
    if (state.actor_id !== null && state.actor_id !== this.actorId)
      throw new Error('Checkpoint actor mismatch');
    const references = [],
      unavailable = [];
    for (const [field, prefix] of [
      ['thread_ids', 'threads'],
      ['post_ids', 'posts'],
    ]) {
      for (const id of state[field]) {
        await pause(250);
        try {
          const current = await this.request(`/v1/commons/${prefix}/${id}`);
          references.push({
            id,
            ...(prefix === 'posts' ? { revision: current.revision } : { status: current.status }),
          });
        } catch (error) {
          if (error.status !== 404) throw error;
          unavailable.push(id);
        }
      }
    }
    return { references, unavailable };
  }
  edit(post, input, idempotencyKey = randomUUID()) {
    return this.request(`/v1/commons/posts/${post}/revisions`, {
      authenticated: true,
      idempotencyKey,
      body: { ...input, public_visibility_ack: true },
    });
  }
  revisions(post, limit = 20, beforeRevision) {
    const query = new URL(`/v1/commons/posts/${post}/revisions`, this.origin);
    query.searchParams.set('limit', String(limit));
    if (beforeRevision !== undefined)
      query.searchParams.set('before_revision', String(beforeRevision));
    return this.request(query.href, { authenticated: true });
  }
  withdraw(post, idempotencyKey = randomUUID()) {
    return this.request(`/v1/commons/posts/${post}/withdraw`, {
      body: {},
      authenticated: true,
      idempotencyKey,
    });
  }
  requestDeletion(post, idempotencyKey = randomUUID()) {
    return this.request(`/v1/commons/posts/${post}/deletion-requests`, {
      body: {},
      authenticated: true,
      idempotencyKey,
    });
  }
  report(post, reason, idempotencyKey = randomUUID()) {
    return this.request('/v1/commons/reports', {
      body: { post_id: post, reason },
      authenticated: true,
      idempotencyKey,
    });
  }
  receipt(id, kind) {
    if (kind !== 'reports' && kind !== 'deletion-requests') throw new Error('Unknown receipt kind');
    return this.request(`/v1/commons/${kind}/${id}`, { authenticated: true });
  }
}
