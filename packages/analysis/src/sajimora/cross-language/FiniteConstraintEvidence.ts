import {ValidationConstraint} from './CanonicalContractIR';
/** Positive finite JSON predicates only. Regex/email/provider-specific behavior
 * remains unqualified. No customer validator is executed. */
export function finiteConstraintAcceptance(value:unknown,constraints:readonly ValidationConstraint[],absent:unknown):'ACCEPT'|'REJECT'|'UNKNOWN' {
  let unknown=false;
  for(const constraint of constraints){
    let accepted:boolean|undefined;
    if(constraint.kind==='NOT_NULL')accepted=value!==null&&value!==absent;
    else if(constraint.kind==='NOT_EMPTY'&&(typeof value==='string'||Array.isArray(value)))accepted=value.length>0;
    else if(constraint.kind==='NOT_BLANK'&&typeof value==='string'&&/^[\x20-\x7e\t\r\n]*$/.test(value))accepted=/[^ \t\r\n]/.test(value);
    else if((constraint.kind==='MIN'||constraint.kind==='MAX')&&typeof value==='number'&&typeof constraint.value==='number')accepted=constraint.kind==='MIN'?value>=constraint.value:value<=constraint.value;
    if(accepted===false)return 'REJECT';if(accepted===undefined)unknown=true;
  }
  return unknown?'UNKNOWN':'ACCEPT';
}
