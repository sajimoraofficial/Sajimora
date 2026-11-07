import json
import sys

def parse_snapshot(file_path):
    with open(file_path, 'r') as f:
        data = json.load(f)

    nodes = data['nodes']
    edges = data['edges']
    strings = data['strings']

    node_field_count = data['snapshot']['meta']['node_fields']
    edge_field_count = data['snapshot']['meta']['edge_fields']
    node_types = data['snapshot']['meta']['node_types'][0]
    edge_types = data['snapshot']['meta']['edge_types'][0]

    node_len = len(node_field_count)
    edge_len = len(edge_field_count)

    print("Parsing nodes...")
    node_by_index = {} # node_idx -> {id, name, edge_count, edge_start}
    node_by_id = {}
    
    edge_start = 0
    for i in range(0, len(nodes), node_len):
        node_idx = i // node_len
        type_str = node_types[nodes[i]]
        name_str = strings[nodes[i + 1]]
        node_id = nodes[i + 2]
        edge_count = nodes[i + 4]

        node_by_index[node_idx] = {
            'idx': node_idx,
            'id': node_id,
            'name': name_str,
            'type': type_str,
            'edge_start': edge_start,
            'edge_count': edge_count
        }
        node_by_id[node_id] = node_by_index[node_idx]
        edge_start += edge_count

    print("Parsing edges...")
    
    # We want to find nodes that represent ts.Program. 
    # Usually they are 'Object' and have an edge 'getSemanticDiagnostics' (which is a closure).
    program_nodes = []
    
    # Build reverse edges for retaining paths
    retained_by = {} # node_idx -> list of (retainer_node_idx, edge_name)

    for i in range(0, len(edges), edge_len):
        type_idx = edges[i]
        name_or_index = edges[i + 1]
        to_node_idx = edges[i + 2] // node_len
        
        # Edge source is implicit from edge_start. We can find it if we iterate sequentially, but this is a global loop.
        pass

    # Better approach: iterate through nodes and their edges
    edge_idx = 0
    for node_idx in range(len(node_by_index)):
        n = node_by_index[node_idx]
        is_program = False
        
        for e in range(n['edge_count']):
            e_idx = (n['edge_start'] + e) * edge_len
            edge_type = edge_types[edges[e_idx]]
            name_idx = edges[e_idx + 1]
            to_node = edges[e_idx + 2] // node_len
            
            edge_name = ""
            if edge_type in ("property", "internal", "shortcut", "weak"):
                edge_name = strings[name_idx]
            else:
                edge_name = f"index[{name_idx}]"
                
            if edge_name == "getSemanticDiagnostics":
                is_program = True

            if to_node not in retained_by:
                retained_by[to_node] = []
            retained_by[to_node].append((node_idx, edge_name, edge_type))
            
        if is_program and n['type'] == 'object':
            program_nodes.append(n)

    print(f"Found {len(program_nodes)} Program objects.")
    
    def trace_path(node_idx, path, visited):
        if node_idx in visited:
            return None
        n = node_by_index[node_idx]
        
        # If we reached a GC root, return
        if n['name'] == '(GC roots)':
            return path
            
        visited.add(node_idx)
        
        retainers = retained_by.get(node_idx, [])
        for ret_idx, e_name, e_type in retainers:
            # Skip weak edges
            if e_type == 'weak': continue
            
            new_path = path + [f"{node_by_index[ret_idx]['name']}::{e_name}"]
            res = trace_path(ret_idx, new_path, visited.copy())
            if res:
                return res
        return None

    for p in program_nodes:
        print(f"\\nTracing retainers for Program @{p['id']}")
        # Only print direct retainers first
        retainers = retained_by.get(p['idx'], [])
        for ret_idx, e_name, e_type in retainers:
            if e_type == 'weak': continue
            ret_node = node_by_index[ret_idx]
            print(f"  Retained by {ret_node['type']} '{ret_node['name']}' via {e_type} '{e_name}'")
            
            # Trace one level up
            ret2 = retained_by.get(ret_idx, [])
            for r2_idx, e2_name, e2_type in ret2:
                if e2_type == 'weak': continue
                r2_node = node_by_index[r2_idx]
                print(f"    -> Retained by {r2_node['type']} '{r2_node['name']}' via {e2_type} '{e2_name}'")

if __name__ == '__main__':
    parse_snapshot(sys.argv[1])
