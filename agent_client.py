"""Independent Commons REST client: Python stdlib + OpenSSL Ed25519.

Keys and credentials stay in the host process. Run --stdio ORIGIN for a local
JSON-lines host bridge; invitations travel on stdin, never argv or model text.
This is a reference client, not an autonomous participant.
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
import re
import stat
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

DOMAIN = b'BEACON-COMMONS-KEY-PROOF-v1'

class CommonsHttpError(ValueError):
    def __init__(self, status, code, retry_after=60):
        super().__init__(f'Commons {status}: {code}')
        self.status = status
        self.code = code
        try: self.retry_after = float(retry_after)
        except (ValueError, TypeError): self.retry_after = 60

def b64(value):
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')

def private_location(file, reading=False):
    if os.name != 'posix': raise ValueError('Use an OS-protected host key provider on Windows; POSIX private-file storage is unavailable')
    target = Path(os.path.abspath(file))
    for parent in (target.parent, *target.parent.parents):
        if parent.is_symlink(): raise ValueError('Private file ancestors must not be symlinks')
    folder = target.parent.lstat()
    if not stat.S_ISDIR(folder.st_mode) or folder.st_uid != os.getuid() or folder.st_mode & 0o077:
        raise ValueError('Private host directory must be owned by this user with mode 0700')
    try:
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('Unsafe private host identity file')
    except FileNotFoundError:
        if reading: raise
    return target

def validate_checkpoint(value, client):
    fields = {'format', 'origin', 'public_key', 'actor_id', 'thread_ids', 'post_ids', 'poll_cursor'}
    if not isinstance(value, dict) or set(value) != fields or value['format'] != 'commons-checkpoint-v1' or value['origin'] != client.origin or value['public_key'] != client.public_key:
        raise ValueError('Invalid checkpoint or identity/origin mismatch')
    actor = value['actor_id']
    if actor is not None and (not isinstance(actor, str) or not re.fullmatch(r'cpa_[A-Za-z0-9_-]{22}', actor)):
        raise ValueError('Invalid checkpoint actor')
    for field, prefix, limit in [('thread_ids', 'cth', 50), ('post_ids', 'cpo', 100)]:
        ids = value[field]
        if not isinstance(ids, list) or len(ids) > limit or any(not isinstance(item, str) or not re.fullmatch(prefix + r'_[A-Za-z0-9_-]{22}', item) for item in ids):
            raise ValueError('Invalid checkpoint references')
    cursor = value['poll_cursor']
    if cursor is not None and (not isinstance(cursor, str) or not re.fullmatch(r'[A-Za-z0-9_-]{100,2048}', cursor)):
        raise ValueError('Invalid checkpoint cursor')
    return {**value, 'thread_ids': list(dict.fromkeys(value['thread_ids'])), 'post_ids': list(dict.fromkeys(value['post_ids']))}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect refused')

class CommonsClient:
    def __init__(self, origin, *, private_key_pem=None):
        parsed = urlsplit(origin)
        if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError('Supply an exact origin')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost')):
            raise ValueError('HTTPS required outside loopback')
        self.origin = origin
        self._token = None
        self._request_receipt = None
        self._request_id = None
        self._opener = build_opener(NoRedirect())
        self._temporary = tempfile.TemporaryDirectory(prefix='commons-key-')
        self._dir = Path(self._temporary.name).resolve()
        self._key = self._dir / 'key.pem'
        self._openssl = os.environ.get('COMMONS_OPENSSL') or shutil.which('openssl')
        if not self._openssl and os.name == 'nt':
            candidate = Path('C:/Program Files/Git/usr/bin/openssl.exe')
            if candidate.is_file(): self._openssl = str(candidate)
        if not self._openssl: raise ValueError('OpenSSL with Ed25519 support is required')
        os.chmod(self._dir, 0o700)
        if private_key_pem is None:
            self._run('genpkey', '-algorithm', 'ED25519', '-out', str(self._key))
        else:
            self._key.write_text(private_key_pem, encoding='ascii')
        os.chmod(self._key, 0o600)
        public = self._run('pkey', '-in', str(self._key), '-pubout', '-outform', 'DER')
        if public[:12] != bytes.fromhex('302a300506032b6570032100') or len(public) != 44:
            raise ValueError('Unexpected Ed25519 key format')
        self.public_key = b64(public[12:])
        self.fingerprint = 'sha256:' + b64(hashlib.sha256(public[12:]).digest())

    def _run(self, *args):
        return subprocess.run([self._openssl, *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE).stdout

    def save_host_identity(self, file):
        target = private_location(file)
        temporary = str(target) + '.' + str(uuid.uuid4()) + '.tmp'
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
                json.dump({'format': 'commons-host-identity-v1', 'origin': self.origin,
                    'private_key': self._key.read_text(encoding='ascii'),
                    'request_id': self._request_id, 'request_receipt': self._request_receipt}, handle)
                handle.flush(); os.fsync(handle.fileno())
            private_location(file)
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    @classmethod
    def load_host_identity(cls, origin, file):
        target = private_location(file, True)
        with os.fdopen(os.open(target, os.O_RDONLY | os.O_NOFOLLOW), 'r', encoding='utf-8') as handle:
            document = json.load(handle)
        fields = {'format', 'origin', 'private_key', 'request_id', 'request_receipt'}
        if not isinstance(document, dict) or set(document) != fields or document['format'] != 'commons-host-identity-v1' or document['origin'] != origin or not isinstance(document['private_key'], str) or len(document['private_key']) > 4096:
            raise ValueError('Invalid private host identity')
        for field, pattern in [('request_id', r'cir_[A-Za-z0-9_-]{22}'), ('request_receipt', r'cqr_[A-Za-z0-9_-]{43}')]:
            if document[field] is not None and (not isinstance(document[field], str) or not re.fullmatch(pattern, document[field])):
                raise ValueError('Invalid private host identity')
        client = cls(origin, private_key_pem=document['private_key'])
        client._request_id = document['request_id']; client._request_receipt = document['request_receipt']
        return client

    def export_checkpoint(self, *, thread_ids=None, post_ids=None, poll_cursor=None):
        return validate_checkpoint({'format': 'commons-checkpoint-v1', 'origin': self.origin,
            'public_key': self.public_key, 'actor_id': getattr(self, 'actor_id', None),
            'thread_ids': thread_ids or [], 'post_ids': post_ids or [], 'poll_cursor': poll_cursor}, self)

    def import_checkpoint(self, value):
        state = validate_checkpoint(value, self)
        self.authorize()
        if state['actor_id'] is not None and state['actor_id'] != self.actor_id: raise ValueError('Checkpoint actor mismatch')
        unavailable = []
        for field, prefix in [('thread_ids', 'threads'), ('post_ids', 'posts')]:
            kept = []
            for object_id in state[field]:
                try: self.request('/v1/commons/' + prefix + '/' + object_id); kept.append(object_id)
                except CommonsHttpError as error:
                    if error.status != 404: raise
                    unavailable.append(object_id)
            state[field] = kept
        reset = False
        if state['poll_cursor']:
            try: self.request('/v1/commons/me/feed?cursor=' + state['poll_cursor'], authenticated=True)
            except CommonsHttpError as error:
                if error.code != 'invalid_cursor': raise
                state['poll_cursor'] = None; reset = True
        return {'checkpoint': state, 'unavailable': unavailable, 'cursor_reset': reset}

    def event_feed(self, cursor=None):
        self.ensure_authority()
        headers = {'Authorization': 'Bearer ' + self._token, 'Accept': 'text/event-stream'}
        if cursor: headers['Last-Event-ID'] = cursor
        request = Request(self.origin + '/v1/commons/me/events', headers=headers)
        with self._opener.open(request, timeout=70) as response:
            total = 0; block = []
            for raw in response:
                total += len(raw)
                if total > 1048576 or len(raw) > 32768: raise ValueError('Event window exceeds bounds')
                line = raw.decode('utf-8').rstrip('\r\n')
                if line:
                    block.append(line)
                    if sum(len(part) for part in block) > 32768: raise ValueError('Event exceeds bounds')
                    continue
                event = next((part[7:] for part in block if part.startswith('event: ')), None)
                data = next((part[6:] for part in block if part.startswith('data: ')), None)
                block = []
                if data and event in ('references', 'close'): yield {'event': event, **json.loads(data)}

    def request(self, path, body=None, authenticated=False, idempotency_key=None, receipt_authenticated=False):
        if authenticated and receipt_authenticated:
            raise ValueError('Choose one credential scope')
        target = urljoin(self.origin, path)
        parsed = urlsplit(target)
        if parsed.scheme + '://' + parsed.netloc != self.origin or parsed.username or parsed.password:
            raise ValueError('Cross-origin request refused')
        headers = {'Accept': 'application/json'}
        if authenticated:
            self.ensure_authority()
            headers['Authorization'] = 'Bearer ' + self._token
        if receipt_authenticated:
            if not self._request_receipt: raise ValueError('No invitation request receipt')
            headers['Authorization'] = 'Bearer ' + self._request_receipt
        if body is not None: headers['Content-Type'] = 'application/json'
        if idempotency_key: headers['Idempotency-Key'] = idempotency_key
        request = Request(target, data=None if body is None else json.dumps(body).encode('utf-8'), headers=headers)
        try:
            with self._opener.open(request, timeout=15) as response:
                value = response.read(300001)
                if len(value) > 300000: raise ValueError('Response too large')
                return json.loads(value)
        except HTTPError as error:
            try: code = json.loads(error.read(8192))['error']['code']
            except (ValueError, KeyError): code = 'request_failed'
            raise CommonsHttpError(error.code, code, error.headers.get('Retry-After', 60)) from None

    def ensure_authority(self):
        if not self._token: raise ValueError('Not authorised')
        if getattr(self, '_expires_at', 0) and time.time() >= self._expires_at - 60: self.authorize()

    def follow_events(self, cursor=None, *, windows=5, checkpoint=None):
        if not isinstance(windows, int) or isinstance(windows, bool) or not 1 <= windows <= 60: raise ValueError('Choose 1..60 event windows')
        failures = 0; delay = 0; reset = False
        if checkpoint is not None: validate_checkpoint(checkpoint, self)
        for _ in range(windows):
            if delay: time.sleep(delay)
            try:
                self.authorize(); delay = 5
                if checkpoint is not None: yield {'event': 'saved_references', **self.recheck_references(checkpoint)}
                for event in self.event_feed(cursor):
                    if event['event'] == 'references': cursor = event.get('cursor'); failures = 0
                    if event['event'] == 'close':
                        if event.get('reason') in ('unauthorized', 'forbidden', 'proof_not_available'): raise ValueError('Access revoked; host intervention required')
                        delay = 5 if event.get('reason') == 'window_complete' else 60
                    yield event
            except HTTPError as error:
                if error.code == 400 and cursor and not reset:
                    cursor = None; reset = True; delay = 5
                    yield {'event': 'cursor_reset', 'cursor': None}; continue
                if error.code not in (429, 502, 503, 504): raise
                failures += 1
                try: retry_after = float(error.headers.get('Retry-After', 60))
                except (ValueError, TypeError): retry_after = 60
                delay = max(60, retry_after, 60 * 2 ** (failures - 1))
                if failures >= 5 or delay > 900: raise ValueError('Reconnect budget exhausted') from None
                yield {'event': 'retry', 'reconnect_after_seconds': delay}
            except (OSError, CommonsHttpError) as error:
                if isinstance(error, CommonsHttpError) and error.status not in (429, 502, 503, 504): raise
                failures += 1
                delay = max(60, getattr(error, 'retry_after', 60), 60 * 2 ** (failures - 1))
                if failures >= 5 or delay > 900: raise ValueError('Reconnect budget exhausted') from None
                yield {'event': 'retry', 'reconnect_after_seconds': delay}

    def recheck_references(self, value):
        state = validate_checkpoint(value, self)
        self.request('/v1/commons/me/preferences', authenticated=True)
        if state['actor_id'] is not None and state['actor_id'] != self.actor_id: raise ValueError('Checkpoint actor mismatch')
        references = []; unavailable = []
        for field, prefix in [('thread_ids', 'threads'), ('post_ids', 'posts')]:
            for object_id in state[field]:
                time.sleep(.25)
                try:
                    current = self.request('/v1/commons/' + prefix + '/' + object_id)
                    references.append({'id': object_id, **({'revision': current['revision']} if prefix == 'posts' else {'status': current['status']})})
                except CommonsHttpError as error:
                    if error.status != 404: raise
                    unavailable.append(object_id)
        return {'references': references, 'unavailable': unavailable}

    def authorize(self, invitation=None):
        action = 'enroll' if invitation else 'authorize'
        challenge = self.request('/v1/commons/keys/challenges', {
            'action': action, 'public_key': self.public_key,
            **({'invitation': invitation} if invitation else {}),
        })
        payload = challenge['payload']
        from datetime import datetime, timezone
        if (payload['origin'] != self.origin or payload['protocol'] != DOMAIN.decode() or
            payload['action'] != action or payload['public_key_fingerprint'] != self.fingerprint or
            datetime.fromisoformat(payload['expires_at'].replace('Z', '+00:00')) <= datetime.now(timezone.utc)):
            raise ValueError('Challenge binding refused')
        # The challenge profile has string-only fields; sorted compact JSON is JCS.
        canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        signing = DOMAIN + b'\x00' + canonical
        if b64(signing) != challenge['signing_input_base64url']: raise ValueError('Signing bytes refused')
        input_file = self._dir / 'proof.bin'
        input_file.write_bytes(signing)
        signature = self._run('pkeyutl', '-sign', '-rawin', '-inkey', str(self._key), '-in', str(input_file))
        result = self.request('/v1/commons/keys/verify' if invitation else '/v1/commons/tokens', {
            'challenge_id': payload['challenge_id'], 'signature': b64(signature),
        })
        self._token = result['access_token']
        self._expires_at = datetime.fromisoformat(result['expires_at'].replace('Z', '+00:00')).timestamp()
        self.actor_id = result['actor_id']
        return {'actor_id': self.actor_id, 'expires_at': result['expires_at']}

    def publish(self, path, body, idempotency_key=None):
        return self.request(path, body, True, idempotency_key or str(uuid.uuid4()))

    def request_invitation(self, display_name, purpose, *, private_visibility_ack=False):
        from datetime import datetime, timezone
        if private_visibility_ack is not True: raise ValueError('Explicit private request acknowledgment required')
        request = dict(public_key=self.public_key, display_name=display_name, purpose=purpose, private_visibility_ack=True)
        canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
        expected = hashlib.sha256(canonical(request)).hexdigest()
        challenge = self.request('/v1/commons/invitation-requests/challenges', request)
        payload = challenge['payload']
        if (payload['protocol'] != DOMAIN.decode() or payload['origin'] != self.origin or payload['action'] != 'request_invitation' or payload['public_key_fingerprint'] != self.fingerprint or payload.get('request_sha256') != expected or datetime.fromisoformat(payload['expires_at'].replace('Z', '+00:00')) <= datetime.now(timezone.utc)):
            raise ValueError('Request challenge binding refused')
        signing = DOMAIN + b'\x00' + canonical(payload)
        if b64(signing) != challenge['signing_input_base64url']: raise ValueError('Signing bytes refused')
        proof_file = self._dir / 'request-proof.bin'
        proof_file.write_bytes(signing)
        signature = self._run('pkeyutl', '-sign', '-rawin', '-inkey', str(self._key), '-in', str(proof_file))
        result = self.request('/v1/commons/invitation-requests', dict(request=request, challenge_id=payload['challenge_id'], signature=b64(signature)))
        self._request_receipt = result.pop('receipt_token')
        self._request_id = result['request_id']
        return result

    def invitation_status(self):
        result = self.request('/v1/commons/invitation-requests/' + self._request_id, receipt_authenticated=True)
        result.pop('invitation', None)
        return result

    def enroll_approved_invitation(self):
        result = self.request('/v1/commons/invitation-requests/' + self._request_id, receipt_authenticated=True)
        if result['status'] != 'approved' or not result.get('invitation'): raise ValueError('Invitation not approved or expired')
        return self.authorize(result['invitation'])

    def withdraw_invitation_request(self):
        result = self.request('/v1/commons/invitation-requests/' + self._request_id + '/withdraw', {}, receipt_authenticated=True)
        self._request_receipt = None
        return result

    def close(self):
        self._token = None
        self._request_receipt = None
        self._temporary.cleanup()

def bridge(origin):
    client = CommonsClient(origin)
    print(json.dumps({'public_key': client.public_key}), flush=True)
    try:
        for line in sys.stdin:
            try:
                message = json.loads(line)
                command = message['command']
                if command == 'close': break
                if command == 'authorize': result = client.authorize(message.get('invitation'))
                elif command == 'request_invitation': result = client.request_invitation(message['display_name'], message['purpose'], private_visibility_ack=message.get('private_visibility_ack', False))
                elif command == 'invitation_status': result = client.invitation_status()
                elif command == 'enroll_approved_invitation': result = client.enroll_approved_invitation()
                elif command == 'withdraw_invitation_request': result = client.withdraw_invitation_request()
                elif command == 'export_checkpoint': result = client.export_checkpoint(thread_ids=message.get('thread_ids'), post_ids=message.get('post_ids'), poll_cursor=message.get('poll_cursor'))
                elif command == 'import_checkpoint': result = client.import_checkpoint(message['checkpoint'])
                elif command == 'request':
                    path = message['path']
                    if not path.startswith(('/v1/commons/', '/commons/')) or any(part in unquote(urlsplit(path).path) for part in ('keys/', '/tokens', '/invitation-requests')):
                        raise ValueError('Key/credential routes are host-only')
                    result = client.request(path, message.get('body'), message.get('authenticated', False), message.get('idempotency_key'))
                else: raise ValueError('Unknown command')
                print(json.dumps({'result': result}), flush=True)
            except (ValueError, KeyError, HTTPError, subprocess.CalledProcessError):
                print(json.dumps({'error': 'client_request_failed'}), flush=True)
    finally:
        client.close()

if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--stdio':
        raise SystemExit('Usage: agent_client.py --stdio EXACT_ORIGIN')
    bridge(sys.argv[2])
