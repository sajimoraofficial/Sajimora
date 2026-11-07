import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {qualifySpringJsonSourceProfile} from '../../../src/sajimora/cross-language/SpringJsonSourceProfile';
function profile(extra:Record<string,string>={}){
  const sources={'pom.xml':'<project><argument>--spring.config.name=server</argument></project>','app/src/main/resources/server.yml':'spring:\n  application:\n    name: server\n',...extra};
  return qualifySpringJsonSourceProfile(new Map(Object.entries(sources).map(([file,source])=>[file,{bytes:Buffer.from(source),sha256:createHash('sha256').update(source).digest('hex')}])),'server');
}
describe('captured Spring JSON source defaults',()=>{
  it('selects a build-declared resource and parses nested naming configuration',()=>{
    const result=profile({'app/src/main/resources/server.yml':'spring:\n  jackson:\n    property-naming-strategy: SNAKE_CASE\n'});
    expect(result.blockers).toEqual([]);expect(result.namingStrategy).toBe('SNAKE_CASE');expect(result.assumptions.join(' ')).toContain('No external Spring configuration');
    expect(profile({'pom.xml':'<project/>'}).blockers.length).toBeGreaterThan(0);
    expect(profile({'pom.xml':'<project><spring.config.name>server</spring.config.name></project>'}).blockers.length).toBeGreaterThan(0);
    expect(profile({'pom.xml':'<project><!-- <argument>--spring.config.name=server</argument> --></project>'}).blockers.length).toBeGreaterThan(0);
  });
  it('separates private local codecs and read-only injected consumers from codec registration',()=>{
    expect(profile({'app/src/main/java/Consumer.java':'class Consumer { private final ObjectMapper mapper; String json(Object x){return mapper.writeValueAsString(x);} }','app/src/main/java/Local.java':'import com.fasterxml.jackson.databind.ObjectMapper; class Local { private static final ObjectMapper mapper; static {mapper=new ObjectMapper();mapper.registerModule(custom);} }'}).blockers).toEqual([]);
    expect(profile({'app/src/main/java/Shadow.java':'class Shadow {private final ObjectMapper mapper=JsonMapper.builder().build();void init(){mapper.registerModule(custom);} static class JsonMapper {static ObjectMapper builder(){return shared;}}}'}).blockers.length).toBeGreaterThan(0);
    for(const source of ['@Configuration class C { @Bean ObjectMapper mapper(){return new ObjectMapper();}}','@Configuration class C {@Bean SimpleModule module(){return new SimpleModule();}}','class C implements Jackson2ObjectMapperBuilderCustomizer {}','@JsonComponent class C {}','class C {void extendMessageConverters(List x){}}','class C { ObjectMapper mapper; void init(){mapper.registerModule(custom);}}','class C {ObjectMapper mapper; void init(){unknown(mapper);}}','class C {ObjectMapper mapper; ObjectMapper alias=mapper;}'])expect(profile({'app/src/main/java/C.java':source}).blockers.length).toBeGreaterThan(0);
  });
  it('keeps profiles, imports, placeholders and unsupported Jackson settings unresolved',()=>{
    for(const [file,source] of Object.entries({'app/src/main/resources/server-dev.yml':'spring.jackson.property-naming-strategy=SNAKE_CASE','app/src/main/resources/server.properties':'spring.config.import=optional:file:external.properties','app/src/main/resources/server.yaml':'spring:\n  jackson:\n    property-naming-strategy: ${NAMING:LOWER_CAMEL_CASE}','app/src/main/resources/server.yml':'spring:\n  jackson:\n    serialization:\n      write-single-elem-arrays-unwrapped: true'}))expect(profile({[file]:source}).blockers.length).toBeGreaterThan(0);
  });
  it('does not let test-classpath codec configuration affect production defaults',()=>{
    expect(profile({'app/src/test/java/C.java':'@Configuration class C {@Bean ObjectMapper mapper(){return null;}}','app/src/test/resources/server.properties':'spring.jackson.serialization.foo=true'}).blockers).toEqual([]);
  });
  it('qualifies only a converter with an unconditional disabled write predicate',()=>{
    const disabled='class C extends AbstractJackson2HttpMessageConverter {public boolean canWrite(Class<?> c,MediaType m){return false;}}';
    expect(profile({'app/src/main/java/C.java':disabled}).blockers).toEqual([]);
    expect(profile({'app/src/main/java/C.java':disabled.replace('false','true')}).blockers.length).toBeGreaterThan(0);
    for(const fake of [disabled.replace('public boolean','public static boolean'),'class C extends AbstractJackson2HttpMessageConverter {String x="public boolean canWrite(Class<?> c,MediaType m){return false;}";}'])expect(profile({'app/src/main/java/C.java':fake}).blockers.length).toBeGreaterThan(0);
  });
});
