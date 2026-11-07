import { GenericRepository, VerificationObligation } from '../../../../../../core/src/sajimora/verification';
import { CertifiedExecutionInput } from '../../../certified/integration/CertifiedEvaluationOrchestrator';
import { ProductionF0RouteMaterializer } from '../../../certified/integration/ProductionF0BundleProvider';

/** Formal promotion awaits source-derived relations, environment seals and exact
 * consumer/property binding. Placeholder scalar relations are not evidence. */
export class TypeScriptProductionF0Materializer implements ProductionF0RouteMaterializer {
  public materialize(_obligation: VerificationObligation, _repository: GenericRepository): CertifiedExecutionInput | undefined {
    return undefined;
  }
}
