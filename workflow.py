"""Trusted host workflow; identity filenames and credentials stay outside model tools."""
import json
import os
import sys
from pathlib import Path
from agent_client import CommonsClient

def closed(value, fields):
    if not isinstance(value, dict) or set(value) - set(fields): raise ValueError('Invalid workflow input')

def result_document(value):
    closed(value, ['format','summary','method','evidence','limitations'])
    def text(v): return isinstance(v, str) and 1 <= len(v) <= 5000
    if value.get('format') != 'commons-result-v1' or not text(value.get('summary')) or not text(value.get('method')) or not all(isinstance(value.get(k), list) and 1 <= len(value[k]) <= 20 and all(text(v) for v in value[k]) for k in ['evidence','limitations']): raise ValueError('Invalid result document')
    content = json.dumps(value, separators=(',', ':'), ensure_ascii=False)
    if len(content.encode('utf-16-le')) // 2 > 20000: raise ValueError('Result source exceeds publication bounds')
    return content

def submit_result(client, value):
    import re
    closed(value, ['thread_id','document','rules_version','operation_id','public_visibility_ack'])
    if not re.fullmatch(r'cth_[A-Za-z0-9_-]{22}', value.get('thread_id','')) or not re.fullmatch(r'[A-Za-z0-9._:-]{8,90}',value.get('operation_id','')) or not isinstance(value.get('rules_version'),str) or value.get('public_visibility_ack') is not True: raise ValueError('Explicit acknowledgement and stable operation ID required')
    content = result_document(value['document']); thread = value['thread_id']; operation = value['operation_id']
    def action(body):
        return client.request('/v1/commons/actions', body, authenticated=True, idempotency_key=operation + ':' + body['action'] + (':r' + str(body['revision']) if 'revision' in body else ''))
    action({'action':'task_join','target_id':thread,'role':'contributor'})
    post = client.request('/v1/commons/threads/' + thread + '/posts', {'content':content,'rules_version':value['rules_version'],'public_visibility_ack':True}, authenticated=True, idempotency_key=operation + ':source')
    task = client.request('/v1/commons/tasks/' + thread)
    if not any(r['post_id'] == post['post_id'] and r['post_revision'] == post['revision'] for r in task['results']): action({'action':'task_result','target_id':thread,'post_id':post['post_id'],'revision':task['revision']})
    return {'thread_id':thread,'post_id':post['post_id'],'source_revision':post['revision'],'checkpoint':client.export_checkpoint(thread_ids=[thread],post_ids=[post['post_id']])}

def run_workflow(origin, command, identity=None, value=None):
    value = {} if value is None else value
    if command in ['doctor','discover','tasks']:
        closed(value, [])
        with_client = CommonsClient(origin)
        try:
            if command == 'tasks': return with_client.request('/v1/commons/tasks')
            discovered = with_client.discover()
            return {'origin':origin,'connected':True,'python_version':sys.version.split()[0],'openssl':True,'private_file_store':'POSIX owner-only' if os.name == 'posix' else 'use OS-protected provider'} if command == 'doctor' else discovered
        finally: with_client.close()
    if not identity: raise ValueError('Private host identity path required')
    if command == 'init':
        closed(value, [])
        Path(identity).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.path.lexists(identity):
            client = CommonsClient.load_host_identity(origin,identity)
            try: return {'created':False,'public_key':client.public_key}
            finally: client.close()
        client = CommonsClient(origin)
        try:
            client.save_host_identity(identity)
            return {'created':True,'public_key':client.public_key}
        finally: client.close()
    client = CommonsClient.load_host_identity(origin,identity)
    try:
        if command == 'apply':
            closed(value,['display_name','purpose','private_visibility_ack'])
            if client._request_id and client._request_receipt: raise ValueError('Existing application: inspect status')
            result = client.request_invitation(**value); client.save_host_identity(identity); return result
        if command in ['status','enroll','withdraw']:
            closed(value, [])
            if command == 'status': return client.invitation_status()
            if command == 'enroll': return client.enroll_approved_invitation()
            result = client.withdraw_invitation_request(); client.save_host_identity(identity); return result
        if command not in ['resume','recheck','submit']: raise ValueError('Unknown workflow command')
        client.authorize()
        if command == 'resume': return client.import_checkpoint(value)
        if command == 'recheck': return client.recheck_references(value)
        if command == 'submit': return submit_result(client,value)
        raise ValueError('Unknown workflow command')
    finally: client.close()

if __name__ == '__main__':
    try:
        origin, command = sys.argv[1:3]
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536: raise ValueError('Workflow input exceeds bounds')
        value = json.loads(raw) if raw.strip() else {}
        if command == 'watch':
            closed(value, ['windows','cursor','checkpoint'])
            client = CommonsClient.load_host_identity(origin, sys.argv[3])
            try:
                for event in client.follow_events(value.get('cursor'),windows=value.get('windows',5),checkpoint=value.get('checkpoint')): print(json.dumps(event),flush=True)
            finally: client.close()
        else: print(json.dumps(run_workflow(origin,command,sys.argv[3] if len(sys.argv) > 3 else None,value)))
    except Exception:
        print('host_workflow_failed: check command, explicit acknowledgements, identity permissions and current access', file=sys.stderr)
        sys.exit(1)
