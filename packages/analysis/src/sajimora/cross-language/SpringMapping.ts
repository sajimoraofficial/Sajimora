const verbs: Record<string,string> = {GetMapping:'GET',PostMapping:'POST',PutMapping:'PUT',PatchMapping:'PATCH',DeleteMapping:'DELETE'};
const allMethods = ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS','TRACE'];
export interface SpringMapping { paths: string[]; methods: string[]; unresolved: boolean; params?:string[] }

function splitAttributes(text: string): string[] {
  const result: string[] = [];
  let quote = false, depth = 0, start = 0;
  for (let i=0;i<text.length;i++) {
    if (text[i]==='"' && text[i-1]!=='\\') quote=!quote;
    if (quote) continue;
    if ('{(['.includes(text[i])) depth++;
    if ('})]'.includes(text[i])) depth--;
    if (text[i]===',' && depth===0) {result.push(text.slice(start,i).trim());start=i+1;}
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

/** Literal annotation attributes only; expressions never silently become root routes. */
export function parseSpringMapping(text: string): SpringMapping | undefined {
  const match = /@(RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.exec(text);
  if (!match) return undefined;
  let start = match.index+match[0].length;
  while (/\s/.test(text[start]??'') && start<text.length) start++;
  let attributes = '';
  if(text[start]==='(') {
    let depth=1, quote=false, end=start+1;
    for(;end<text.length && depth;end++) {
      if(text[end]==='"' && text[end-1]!=='\\') quote=!quote;
      if(!quote && text[end]==='(') depth++;
      if(!quote && text[end]===')') depth--;
    }
    if(depth) return {paths:[],methods:[],unresolved:true};
    attributes=text.slice(start+1,end-1);
  }
  let paths = [''], methods = verbs[match[1]] ? [verbs[match[1]]] : allMethods;
  let unresolved = false, routeSeen = false;
  const params:string[]=[];
  for(const attribute of splitAttributes(attributes)) {
    const assignment=/^(\w+)\s*=\s*([\s\S]+)$/.exec(attribute);
    const name=assignment?.[1] ?? 'value', value=assignment?.[2] ?? attribute;
    if(name==='value'||name==='path') {
      if(routeSeen) unresolved=true;
      routeSeen=true;
      const values=value.startsWith('{')&&value.endsWith('}') ? splitAttributes(value.slice(1,-1)) : [value];
      paths=[];
      for(const entry of values) {
        if(!/^"(?:[^"\\]|\\.)*"$/.test(entry)) {unresolved=true;continue;}
        try {paths.push(JSON.parse(entry));} catch {unresolved=true;}
      }
      if(paths.length===0) unresolved=true;
    } else if(name==='method') {
      const values=value.startsWith('{')&&value.endsWith('}') ? splitAttributes(value.slice(1,-1)) : [value];
      methods=[];
      for(const entry of values) {
        const verb=/^(?:RequestMethod\.)?(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/.exec(entry)?.[1];
        if(verb) methods.push(verb);else unresolved=true;
      }
      if(methods.length===0) methods=allMethods;
    } else if(name==='params') {
      const values=value.startsWith('{')&&value.endsWith('}')?splitAttributes(value.slice(1,-1)):[value];
      for(const entry of values) {
        if(!/^"(?:[^"\\]|\\.)*"$/.test(entry)){unresolved=true;continue;}
        try{params.push(JSON.parse(entry));}catch{unresolved=true;}
      }
    } else unresolved=true;
  }
  return {paths:[...new Set(paths)],methods:[...new Set(methods)],unresolved,...(params.length?{params}: {})};
}
