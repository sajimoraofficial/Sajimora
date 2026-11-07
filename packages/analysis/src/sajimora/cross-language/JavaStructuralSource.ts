export interface JavaStructuralMethod {name:string;lineStart:number;lineEnd:number;modifiers:string;parameters:readonly {name:string;text:string}[]}
export interface JavaStructuralClass {name:string;lineStart:number;lineEnd:number;modifiers:string;typeParameters:string;methods:JavaStructuralMethod[]}
let parser:any;
export function indexJavaDeclarations(text:string): {classes:JavaStructuralClass[];complete:boolean} {
  if(!parser){const Parser=require('tree-sitter');parser=new Parser();parser.setLanguage(require('tree-sitter-java'));}
  const tree=parser.parse(text,undefined,{bufferSize:Math.max(32768,text.length*2+1024)}),classes:JavaStructuralClass[]=[];
  try {
    const visit=(node:any,owner?:JavaStructuralClass)=>{
      if(['class_declaration','interface_declaration','record_declaration'].includes(node.type)) {
        owner={name:node.childForFieldName('name')?.text??'',lineStart:node.startPosition.row+1,lineEnd:node.endPosition.row+1,modifiers:node.namedChildren.find((child:any)=>child.type==='modifiers')?.text??'',typeParameters:node.childForFieldName('type_parameters')?.text??'',methods:[]};
        classes.push(owner);
      }
      if(['method_declaration','constructor_declaration','compact_constructor_declaration'].includes(node.type)&&owner)owner.methods.push({name:node.childForFieldName('name')?.text??owner.name,lineStart:node.startPosition.row+1,lineEnd:node.endPosition.row+1,modifiers:node.namedChildren.find((child:any)=>child.type==='modifiers')?.text??'',parameters:(node.childForFieldName('parameters')?.namedChildren??[]).filter((child:any)=>child.type==='formal_parameter'||child.type==='spread_parameter').map((child:any)=>({name:child.childForFieldName('name')?.text??'',text:child.text}))});
      for(const child of node.namedChildren)visit(child,owner);
    };visit(tree.rootNode);
    return {classes,complete:!tree.rootNode.hasError};
  } finally {tree.delete?.();}
}
