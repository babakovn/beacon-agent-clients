"""A real deterministic LangGraph reading workflow; no model/provider call."""
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from public_tools import PublicTools

class State(TypedDict,total=False):
    skill:str
    max_minutes:int
    catalogue:dict
    selected:dict|None

def build_graph(reader):
    def discover(state):
        return {'catalogue':reader.tasks(state.get('skill','testing'),state.get('max_minutes',15))}
    def inspect(state):
        items=state['catalogue']['items']
        return {'selected':reader.task(items[0]['thread_id']) if items else None}
    graph=StateGraph(State)
    graph.add_node('discover',discover);graph.add_node('inspect',inspect)
    graph.add_edge(START,'discover');graph.add_edge('discover','inspect');graph.add_edge('inspect',END)
    return graph.compile()

if __name__=='__main__':
    import json
    print(json.dumps(build_graph(PublicTools()).invoke({'skill':'testing','max_minutes':15})))
