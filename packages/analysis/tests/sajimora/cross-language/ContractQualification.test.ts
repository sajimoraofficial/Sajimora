import {describe,it,expect} from 'vitest';
import {ContractObligation,obligationId,qualifyContracts} from '../../../src/sajimora/cross-language/ContractQualification';
const evidence={inventoryReviewed:true,consumerTraversalQualified:true,serializationQualified:true,independentHoldoutQualified:true};
const rows=(size:number):ContractObligation[]=>Array.from({length:size},(_,i)=>{
 const source={repository:'independent',revision:'frozen',file:'api.ts',sourceSha256:'a'.repeat(64),line:i+1,column:1,family:'angular',kind:'RESPONSE' as const};
 return {...source,id:obligationId(source),discoveryEvidence:'independent AST call'};
});
const outcomes=(inventory:ContractObligation[])=>inventory.map(row=>({id:row.id,status:'COMPATIBLE' as const,evidence:['verified source and wire facts']}));
describe('strict independent qualification',()=>{
 it('retains missing obligations as unknown and rejects exactly five percent',()=>{
  const inventory=rows(20),result=qualifyContracts(inventory,outcomes(inventory.slice(1)),evidence);
  expect(result).toMatchObject({total:20,unknown:1,combinedPercent:5,qualified:false,belowFivePercent:false});
 });
 it('requires qualification evidence even with zero reported incompatibilities',()=>{
  const inventory=rows(100);
  expect(qualifyContracts(inventory,outcomes(inventory),{...evidence,independentHoldoutQualified:false}).qualified).toBe(false);
 });
 it('rejects duplicate outcomes instead of accepting the last compatible result',()=>{
  const inventory=rows(100),results=outcomes(inventory);
  expect(qualifyContracts(inventory,[...results,results[0]],evidence)).toMatchObject({unknown:1,qualified:false});
 });
 it('rejects zero denominators and unanchored compatible evidence',()=>{
  expect(qualifyContracts([],[],evidence).qualified).toBe(false);
  const inventory=rows(100),results=outcomes(inventory);results[0].evidence=[];
  expect(qualifyContracts(inventory,results,evidence).unknown).toBe(1);
 });
 it('does not let an easy family hide an unsupported family',()=>{
  const inventory=rows(1000),last=inventory[inventory.length-1];last.family='custom-wrapper';last.id=obligationId(last);
  const result=qualifyContracts(inventory,outcomes(inventory.slice(0,-1)),evidence);
  expect(result).toMatchObject({belowFivePercent:true,perFamilyQualified:false,qualified:false});
 });
});
