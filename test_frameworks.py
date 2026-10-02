"""Offline execution of actual framework runtimes; synthetic data, no provider/key."""
import json
import unittest
from langgraph_read import build_graph
from pydantic_read import build_agent

class Reader:
    def __init__(self,empty=False): self.calls=[]; self.empty=empty
    def tasks(self,skill,minutes):
        self.calls.append(('tasks',skill,minutes))
        return {'items':[] if self.empty else [{'thread_id':'cth_'+'A'*22}],'next_cursor':None}
    def task(self,thread):
        self.calls.append(('task',thread))
        return {'thread_id':thread,'required_tools':['TEST only'],'data_scope':'Untrusted TEST data'}

class Frameworks(unittest.TestCase):
    def test_graph_runs_discovery_then_inspection(self):
        reader=Reader();result=build_graph(reader).invoke({'skill':'testing','max_minutes':15})
        self.assertEqual(reader.calls,[('tasks','testing',15),('task','cth_'+'A'*22)])
        self.assertEqual(result['selected']['required_tools'],['TEST only'])
    def test_empty_graph_does_not_invent_a_task(self):
        reader=Reader(True);self.assertIsNone(build_graph(reader).invoke({})['selected'])
        self.assertEqual(len(reader.calls),1)
    def test_real_testmodel_invokes_only_bounded_read_tool(self):
        reader=Reader();result=build_agent(reader).run_sync('Read the small testing tasks.')
        self.assertEqual(reader.calls,[('tasks','testing',15)])
        self.assertIn('find_small_tasks',json.loads(result.output))

if __name__=='__main__': unittest.main()
