import {createHash} from 'node:crypto';
import {extractSnapshotJacksonConfig} from './JacksonSnapshotConfig';
import type {ArtifactBlocker} from './ContractArtifactEnvelope';

/** Source-default configuration only. External settings and runtime bean changes
 * are explicit assumptions; opaque source customizers remain evidence requests. */
export function qualifySpringJsonSourceProfile(files:ReadonlyMap<string,{bytes:Buffer;sha256:string}>,configName:string){
  const blockers:ArtifactBlocker[]=[],parts:string[]=[],configs=new Map<string,string>();
  const gap=(file:string,message:string)=>blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',file,message});
  if(!/^[A-Za-z0-9_-]+$/.test(configName))gap('<selection>','A single literal Spring configuration name is required');
  let selected=false,declared=false;
  for(const [file,value] of files){
    if(/(?:^|\/)src\/test\//.test(file))continue;
    const source=value.bytes.toString('utf8'),base=file.split('/').pop()!;
    if(base==='pom.xml'){
      const xml=source.replace(/<!--[\s\S]*?-->/g,'');
      const names=[...xml.matchAll(/<spring\.config\.name>\s*([^<]+)\s*<\/spring\.config\.name>/g)].map(m=>m[1].trim());
      const argumentsList=[...xml.matchAll(/<argument>\s*--spring\.config\.name=([A-Za-z0-9_-]+)\s*<\/argument>/g)].map(m=>m[1]);
      // A test system property does not establish production selection. The CLI
      // selects a source profile explicitly, corroborated by a captured command.
      if(argumentsList.includes(configName))declared=true;
      if(names.includes(configName)||argumentsList.includes(configName))parts.push(file+':'+value.sha256);
    }
    if(new RegExp('^'+configName+'(?:-[^.]+)?\\.(?:properties|ya?ml)$').test(base)){
      selected=true;parts.push(file+':'+value.sha256);
      const normalized=file.slice(0,file.length-base.length)+base.replace(configName,'application');configs.set(normalized,source);
    }
    if(!file.endsWith('.java'))continue;
    const text=source.replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,token=>' '.repeat(token.length));
    // Registration/customization can replace the codec even without mentioning ObjectMapper.
    if(/\b(?:Jackson2ObjectMapperBuilderCustomizer|JsonComponent|EnableWebMvc|configureMessageConverters|extendMessageConverters|setMessageConverters)\b/.test(text)||/@Bean\b[\s\S]*\b(?:ObjectMapper|JsonMapper|Jackson2ObjectMapperBuilder|\w*Module|HttpMessageConverters?)\b/.test(text)){
      parts.push(file+':'+value.sha256);gap(file,'Source-visible JSON codec registration or customization requires qualification');continue;
    }
    // A converter whose declared write predicate is unconditionally false cannot
    // encode an endpoint body. No package/class-name allowlist is involved.
    if(/extends\s+AbstractJackson2HttpMessageConverter\b/.test(text)){
      if([...text.matchAll(/\bboolean\s+canWrite\s*\(/g)].length!==1||!/\bpublic\s+boolean\s+canWrite\s*\(Class<\?>\s+\w+\s*,\s*MediaType\s+\w+\s*\)\s*\{\s*return\s+false\s*;\s*\}/.test(text))gap(file,'Custom message converter write behavior requires qualification');
      parts.push(file+':'+value.sha256);continue;
    }
    if(/extends\s+(?:ObjectMapper|JsonMapper|MappingJackson2HttpMessageConverter)\b/.test(text)){parts.push(file+':'+value.sha256);gap(file,'Custom JSON codec subclass requires qualification');continue;}
    if(!/\b(?:ObjectMapper|Jackson2ObjectMapperBuilder)\b/.test(text))continue;
    const nativeFresh=(expression:string)=>{
      if(/^new\s+com\.fasterxml\.jackson\.databind\.ObjectMapper\b|^com\.fasterxml\.jackson\.databind\.json\.JsonMapper\.builder\s*\(/.test(expression))return true;
      if(/^new\s+ObjectMapper\b/.test(expression))return /import\s+com\.fasterxml\.jackson\.databind\.ObjectMapper\s*;/.test(text)&&!/(?:class|interface|enum|record)\s+ObjectMapper\b/.test(text);
      return /^JsonMapper\.builder\s*\(/.test(expression)&&/import\s+com\.fasterxml\.jackson\.databind\.json\.JsonMapper\s*;/.test(text)&&!/(?:class|interface|enum|record)\s+JsonMapper\b/.test(text);
    };
    // Directly injected mapper consumers must use only non-mutating Jackson
    // operations; aliasing or escaping an injected mapper is not qualified.
    for(const match of text.matchAll(/\bObjectMapper\s+(\w+)\s*(?:;|=)/g)){
      const name=match[1];
      const prefix=text.slice(Math.max(0,match.index!-40),match.index!);
      const initializer=text.slice(match.index!+match[0].length).trimStart();
      if(/\bfinal\s+$/.test(prefix)&&match[0].trimEnd().endsWith('=')&&nativeFresh(initializer))continue;
      const assignments=[...text.matchAll(new RegExp('\\b'+name+'\\s*=\\s*([^;]+)','g'))];
      if(assignments.length&&assignments.every(assignment=>nativeFresh(assignment[1])))continue;
      const withoutImports=text.replace(/^\s*import\s+[^;]+;/gm,'');
      const occurrences=[...withoutImports.matchAll(new RegExp('\\b'+name+'\\b','g'))];
      for(const occurrence of occurrences){
        const offset=occurrence.index!,prefix=withoutImports.slice(Math.max(0,offset-30),offset),suffix=withoutImports.slice(offset+name.length);
        if(/\bObjectMapper\s+$/.test(prefix))continue;
        if(/^\s*\.\s*(?:readValue|readTree|writeValueAsString|writeValueAsBytes|valueToTree|treeToValue|convertValue|writerWithDefaultPrettyPrinter|readerFor|writerFor)\s*\(/.test(suffix))continue;
        gap(file,'Injected mapper mutation, alias or escape requires a codec effect summary');break;
      }
    }
  }
  if(!declared)gap('<selection>','Selected Spring configuration name is not declared literally by captured build configuration');
  if(!selected)gap('<selection>','Selected Spring configuration resource is missing');
  const parsed=extractSnapshotJacksonConfig(configs);
  blockers.push(...parsed.blockers.map(b=>({...b,code:'UNRESOLVED_JACKSON_CONFIG' as const})));
  if(parsed.naming!=='CAMEL_CASE'&&parsed.naming!=='SNAKE_CASE')gap('<selection>','Exporter naming profile does not support '+parsed.naming);
  return {fingerprint:parts.length?createHash('sha256').update(parts.sort().join('\n')).digest('hex').slice(0,32):null,namingStrategy:parsed.naming==='SNAKE_CASE'?'SNAKE_CASE' as const:'CAMEL_CASE' as const,blockers,assumptions:[
    'Explicit source profile uses captured Spring configuration name: '+configName,
    'Default Spring MVC Jackson JSON codec under captured source configuration',
    'No external Spring configuration, active profile override, runtime codec registration or reflective mapper mutation',
  ]};
}
