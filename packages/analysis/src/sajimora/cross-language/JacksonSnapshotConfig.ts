import { AnalysisBlocker } from './CrossLanguageContracts';
import { JacksonNamingStrategy } from './JavaWireModelEngine';

/** Qualify the bounded default mapper profile; custom/profile-dependent settings fail closed. */
export function extractSnapshotJacksonConfig(files: ReadonlyMap<string, string>): { naming: JacksonNamingStrategy; namingResolved: boolean; blockers: AnalysisBlocker[] } {
  let naming: JacksonNamingStrategy = 'CAMEL_CASE';
  const values = new Set<JacksonNamingStrategy>();
  const blockers: AnalysisBlocker[] = [];
  const strategies: Record<string, JacksonNamingStrategy> = {
    LOWER_CAMEL_CASE: 'CAMEL_CASE', CAMEL_CASE: 'CAMEL_CASE', SNAKE_CASE: 'SNAKE_CASE',
    KEBAB_CASE: 'KEBAB_CASE', UPPER_CAMEL_CASE: 'UPPER_CAMEL_CASE', LOWER_DOT_CASE: 'LOWER_DOT_CASE',
  };
  for (const [file, source] of files) {
    if (file.endsWith('lombok.config') && source.replace(/^\s*#.*$/gm, '').trim()) blockers.push({ code: 'UNSUPPORTED_LOMBOK_ACCESSOR', file, message: 'Lombok configuration overrides require a qualified accessor profile' });
    if (file.endsWith('.java')) {
      const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
      if (/\b(?:ObjectMapper|Jackson2ObjectMapperBuilder|Jackson2ObjectMapperBuilderCustomizer)\b/.test(text)) blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', file, message: 'Custom mapper configuration requires a qualified codec profile' });
      continue;
    }
    if (!/application[^/]*\.(?:properties|ya?ml)$/.test(file)) continue;
    const yaml = /\.ya?ml$/.test(file);
    const stack: { indent: number; key: string }[] = [];
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*[#!]/.test(line) || !line.trim()) continue;
      if(yaml&&/(?:^|\s)[&*][\w-]+|^\s*---\s*$/.test(line))blockers.push({code:'UNRESOLVED_JACKSON_CONFIG',file,message:'YAML aliases, anchors or multiple documents require configuration qualification'});
      const match = line.match(yaml ? /^(\s*)([\w.-]+|"[^"\r\n]+"|'[^'\r\n]+')\s*:\s*(.*?)\s*$/ : /^(\s*)([\w.-]+)\s*[:=]\s*(.*?)\s*$/);
      if (!match) {
        if (/jackson|spring\.config|---|[&*]/.test(line)) blockers.push({ code: 'UNRESOLVED_JACKSON_CONFIG', file, message: 'Unsupported application configuration syntax may affect Jackson' });
        continue;
      }
      const indent = match[1].length;
      if (yaml) while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const localKey=match[2].replace(/^["']|["']$/g,'');
      const key = [...stack.map(item => item.key), localKey].join('.');
      const value = match[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
      if (yaml && !value) { stack.push({ indent, key: localKey }); continue; }
      if (key.startsWith('spring.config.') || key.startsWith('spring.profiles.')) blockers.push({ code: 'UNRESOLVED_JACKSON_CONFIG', file, message: 'External or profile-dependent application configuration is unresolved' });
      if (!key.startsWith('spring.jackson.')) continue;
      if (/application-[^/]+\./.test(file)) blockers.push({ code: 'UNRESOLVED_JACKSON_CONFIG', file, message: 'Profile-dependent Jackson configuration cannot be selected from static snapshots' });
      if (key !== 'spring.jackson.property-naming-strategy') { blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', file, message: `Unqualified Jackson setting ${key}` }); continue; }
      const strategy = strategies[value];
      if (!strategy) blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', file, message: `Unsupported Jackson naming strategy: ${value}` });
      else values.add(strategy);
    }
  }
  if (values.size > 1) blockers.push({ code: 'UNSUPPORTED_JACKSON_FEATURE', message: 'Conflicting Jackson naming strategies in sealed configuration' });
  else if (values.size) naming = [...values][0];
  return { naming, namingResolved: values.size > 0, blockers };
}
