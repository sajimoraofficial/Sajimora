import { ClosureEvidence, RepositoryAnalysisUniverse, SymbolRef } from '@sajimora/core';
import { AnalysisContext } from '../context/AnalysisContext';
import { AmbientReferenceClosure } from './AmbientReferenceClosure'; import { InheritanceClosure } from './InheritanceClosure'; import { InterfaceImplClosure } from './InterfaceImplClosure'; import { OverrideClosure } from './OverrideClosure'; import { ReExportClosure } from './ReExportClosure'; import { TypeReferenceClosure } from './TypeReferenceClosure'; import { ValueReferenceClosure } from './ValueReferenceClosure';
import { RollupResult, UsageClosureRollup } from '../rollup/UsageClosureRollup';
export interface ConsumerDiscoveryEvidence { closures: ClosureEvidence[]; rollup: RollupResult }
export class ConsumerDiscoveryCoordinator {
  discover(context: AnalysisContext, target: SymbolRef, universe: RepositoryAnalysisUniverse): ConsumerDiscoveryEvidence {
    const closures = [new ValueReferenceClosure().execute(context,target,universe),new TypeReferenceClosure().execute(context,target,universe),new InheritanceClosure().execute(context,target,universe),new InterfaceImplClosure().execute(context,target,universe),new OverrideClosure().execute(context,target,universe),new ReExportClosure().execute(context,target,universe),new AmbientReferenceClosure().execute(context,target,universe)];
    return { closures, rollup: UsageClosureRollup.rollup(closures) };
  }
}
