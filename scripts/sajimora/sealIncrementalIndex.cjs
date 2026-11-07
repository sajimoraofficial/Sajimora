const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(process.argv[2]),files=[];
const addTree=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())addTree(file);else files.push(file);}};
addTree('rust/crates/source-index/src');addTree('rust/crates/source-index/tests');addTree('rust/crates/source-index/examples');
files.push('rust/Cargo.toml','rust/Cargo.lock','rust/crates/source-index/Cargo.toml','rust/crates/sajimora-cli/Cargo.toml','rust/crates/sajimora-cli/src/index_source.rs','rust/crates/sajimora-cli/src/source_pilot.rs','rust/crates/sajimora-cli/tests/java_worker.rs','rust/crates/sajimora-cli/tests/incremental.rs','rust/audit/bounded-index/schema-v1.sql');
for(const name of ['measureColdExtraction.ps1','verifySourceCapture.cjs','compareJavaPilotVersions.cjs','verifyColdMilestone.cjs','createColdScaleFixture.cjs','sealColdIndexMilestone.cjs','createIncrementalFixtures.cjs','verifyIncrementalIndexes.cjs','sealIncrementalIndex.cjs'])files.push(path.join('scripts/sajimora',name));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources=files.map(file=>{const target=path.join(root,'source-snapshot',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);return {path:file.replaceAll('\\','/'),sha256:hash(file)};});
const executables=['rust/target/release/sajimora-source-pilot.exe','rust/target/release/sajimora.exe'].map(file=>{const snapshot=path.join(root,'binary-snapshot',path.basename(file));fs.mkdirSync(path.dirname(snapshot),{recursive:true});fs.copyFileSync(file,snapshot);return {path:file,snapshot:path.relative(root,snapshot).replaceAll('\\','/'),sha256:hash(file)};});
const manifest={scope:'Windows bounded recoverable cross-commit Java structural index; conservative semantic invalidation; semantic and TypeScript migration remain open',rust:'1.99.0 stable x86_64-pc-windows-msvc',sqlite:'3.53.2 bundled rusqlite 0.40.2',sources,executables};
fs.writeFileSync(path.join(root,'build-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({sources:sources.length,executables},null,2));

