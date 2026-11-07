import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {discoverContractObligations} from '../../packages/analysis/src/sajimora/cross-language/IndependentContractInventory';
import {qualifyContracts} from '../../packages/analysis/src/sajimora/cross-language/ContractQualification';
import {GitRepository} from '../../packages/analysis/src/sajimora/snapshots/GitRepository';
import {captureSnapshotPair} from '../../packages/analysis/src/sajimora/cross-language/CrossLanguageSnapshotPair';
const [repository,output]=process.argv.slice(2);
if(!repository||!output)throw Error('Usage: qualifyRepository.ts <repository> <output-directory>');
const revision=execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const status=execFileSync('git',['-C',repository,'status','--porcelain'],{encoding:'utf8'});
async function main(){
const snapshot=await captureSnapshotPair({repository:new GitRepository(path.resolve(repository)),parentCommit:revision,candidate:{kind:'commit',sha:revision},includeExtensions:['.java','.ts','.tsx','.js','.jsx']});
const sources=new Map([...snapshot.candidateFiles].map(([file,value])=>[file as string,value.bytes.toString('utf8')]));
const inventory=discoverContractObligations(sources,path.resolve(repository),revision);
// No extracted-call verdict is promoted to verified evidence. Missing review stays UNKNOWN.
const qualification=qualifyContracts(inventory,[],{inventoryReviewed:false,consumerTraversalQualified:false,serializationQualified:false,independentHoldoutQualified:false});
if(execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==revision||execFileSync('git',['-C',repository,'status','--porcelain'],{encoding:'utf8'})!==status)throw Error('Repository changed during discovery');
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'independent-inventory.json'),JSON.stringify({repository:path.resolve(repository),revision,sourceFiles:sources.size,capture:'immutable Git commit',workingTreeStatus:status,reviewed:false,inventory}));
fs.writeFileSync(path.join(output,'qualification.json'),JSON.stringify(qualification,null,2));
console.log(JSON.stringify({repository,revision,sourceFiles:sources.size,obligations:inventory.length,qualification}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
