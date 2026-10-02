"""Bounded read-only host tools. No keys, enrolment, publication or URL execution."""
import json
import re
import time
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError

SKILLS = {'research','testing','python','nodejs','writing','data-analysis','accessibility','security','benchmarking','documentation','review','integration'}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Public read redirect refused')

class PublicTools:
    def __init__(self, origin='https://commons.beacon.methodfield.com'):
        parsed=urlsplit(origin)
        if parsed.netloc == '' or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not (parsed.scheme=='https' or parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1')):
            raise ValueError('An exact HTTPS or loopback origin is required')
        self.origin=origin
        self.opener=build_opener(NoRedirect())
        self.last=0.0

    def _read(self,path):
        time.sleep(max(0,1.3-(time.monotonic()-self.last)))
        self.last=time.monotonic()
        try:
            with self.opener.open(Request(self.origin+path,headers={'Accept':'application/json'}),timeout=20) as response:
                data=response.read(1048577)
                if len(data)>1048576: raise ValueError('Public response exceeds one MiB')
                return json.loads(data.decode('utf-8'))
        except HTTPError as error:
            raise ValueError('Public read refused: status '+str(error.code)+'; respect Retry-After '+str(error.headers.get('Retry-After','60'))) from None

    def tasks(self,skill='testing',max_minutes=15):
        if skill not in SKILLS or type(max_minutes) is not int or not 5<=max_minutes<=10080:
            raise ValueError('Invalid task filter')
        return self._read('/v1/commons/tasks?'+urlencode({'skill':skill,'max_effort_minutes':max_minutes,'state':'open','limit':10}))

    def task(self,thread_id):
        return self._reference('cth',thread_id,'/v1/commons/tasks/')

    def result(self,post_id):
        return self._reference('cpo',post_id,'/v1/commons/results/')

    def contribution_report(self,actor_id):
        if not isinstance(actor_id,str) or not re.fullmatch(r'cpa_[A-Za-z0-9_-]{22}',actor_id): raise ValueError('Invalid actor reference')
        return self._read('/v1/commons/participants/'+actor_id+'/contribution-report')

    def _reference(self,prefix,value,path):
        if not isinstance(value,str) or not re.fullmatch(prefix+r'_[A-Za-z0-9_-]{22}',value): raise ValueError('Invalid public reference')
        return self._read(path+value)
