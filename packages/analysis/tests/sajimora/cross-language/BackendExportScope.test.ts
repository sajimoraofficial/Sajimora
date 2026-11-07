import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

describe('backend source export qualification boundaries',()=>{
  it('excludes test-classpath configuration, preserves production/profile/generic uncertainty and respects source root boundaries',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sajimora-backend-scope-'));
    const root=path.resolve(__dirname,'../../../../..');
    const main='app/src/main/java';
    const files:Record<string,string>={
      [main+'/Controller.java']:'package demo;\n@RestController\npublic class Controller {\n@GetMapping("/orders")\npublic Page<OrderDTO> list(){return null;}\n}',
      [main+'/OrderDTO.java']:'package demo;\npublic record OrderDTO(int id) {}',
      [main+'/Api.java']:'package demo;\npublic interface Api {\n@GetMapping("/inherited")\npublic String inherited();\n}',
      [main+'/InheritedController.java']:'package demo;\n@RestController\npublic class InheritedController implements Api {\n@Override\npublic String inherited(){return "";}\n}',
      [main+'/MapperConfig.java']:'package demo;\n@Configuration\npublic class MapperConfig {\n@Bean\npublic ObjectMapper mapper(){return new ObjectMapper();}\n}',
      'app/src/main/java-other/OtherController.java':'package other;\n@RestController\npublic class OtherController {\n@GetMapping("/excluded")\npublic String other(){return "";}\n}',
      'app/src/main/resources/application.properties':'spring.application.name=fixture',
      'app/src/main/resources/application-test.properties':'spring.jackson.property-naming-strategy=SNAKE_CASE',
      'app/src/test/java/MapperTest.java':'class MapperTest { ObjectMapper mapper; }',
      'app/src/test/resources/application-test.properties':'spring.jackson.serialization.fail-on-empty-beans=false'
    };
    try {
      for(const [file,source] of Object.entries(files)){const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,source);}
      execFileSync('git',['init',dir],{stdio:'pipe'});
      execFileSync('git',['-C',dir,'add','.'],{stdio:'pipe'});
      execFileSync('git',['-C',dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture'],{stdio:'pipe'});
      const sha=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
      const run=(javaRoot?:string)=>JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/test-runtime/run-tsx-command.cjs'),path.join(root,'scripts/sajimora/exportContract.ts'),'--repo',dir,'--parent',sha,'--working-tree','--service-id','fixture',...(javaRoot?['--java-root',javaRoot]:[])],{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe']}));
      const scoped=run(main);
      expect(scoped.payload.endpoints.map((e:any)=>e.identity.normalizedRoute.rawPath)).toEqual(['/orders']);
      expect(scoped.completeness.blockers.some((b:any)=>b.file?.includes('/src/test/'))).toBe(false);
      expect(scoped.completeness.blockers.some((b:any)=>b.file?.endsWith('/MapperConfig.java'))).toBe(true);
      expect(scoped.completeness.blockers.some((b:any)=>b.file?.endsWith('/main/resources/application-test.properties'))).toBe(true);
      expect(scoped.completeness.blockers.some((b:any)=>b.code==='UNRESOLVED_JAVA_GENERIC')).toBe(true);
      expect(scoped.completeness.blockers.some((b:any)=>b.code==='UNRESOLVED_ROUTE'&&b.file.endsWith('InheritedController.java')&&b.message.includes('Inherited Spring mappings'))).toBe(true);
      expect(scoped.payload.endpoints[0].body.kind).toBe('UNKNOWN');expect(scoped.completeness.complete).toBe(false);
      const unscoped=run();
      expect(unscoped.completeness.blockers.some((b:any)=>b.file?.includes('/src/test/'))).toBe(true);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  },30000);
});
