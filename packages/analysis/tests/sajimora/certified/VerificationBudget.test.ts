import { VerificationBudget, VerificationBudgetExhaustedError } from '../../../src/sajimora/certified/proof/VerificationBudget';
import { INITIAL_RESOURCE_PROFILE } from '../../../../core/src/sajimora/certified/protocol';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function expectThrow(fn: () => void, errorType: any, message: string) {
  try {
    fn();
    throw new Error(`Expected to throw, but didn't: ${message}`);
  } catch (e) {
    if (!(e instanceof errorType)) {
      throw new Error(`Expected ${errorType.name} but got ${e}: ${message}`);
    }
  }
}

console.log('Testing VerificationBudget...');

// 1. allocates resources and tracks consumption
{
  const budget = new VerificationBudget({ ...INITIAL_RESOURCE_PROFILE });
  budget.allocate('VERTICES', 10);
  assert(budget.getConsumed('VERTICES') === 10, 'Consumed vertices should be 10');
}

// 2. throws VerificationBudgetExhaustedError when limit is exceeded
{
  const budget = new VerificationBudget({ ...INITIAL_RESOURCE_PROFILE });
  budget.allocate('VERTICES', INITIAL_RESOURCE_PROFILE.maxVertices);
  expectThrow(() => {
    budget.allocate('VERTICES', 1);
  }, VerificationBudgetExhaustedError, 'Should throw on exceeding limit');
}

// 3. supports cancellation and throws immediately on next allocation
{
  const budget = new VerificationBudget({ ...INITIAL_RESOURCE_PROFILE });
  budget.cancel();
  expectThrow(() => {
    budget.allocate('WORK_UNITS', 1);
  }, VerificationBudgetExhaustedError, 'Should throw after cancellation');
}

// 4. fails atomically without allowing partial progress after limit
{
  const budget = new VerificationBudget({ ...INITIAL_RESOURCE_PROFILE });
  expectThrow(() => {
    budget.allocate('EDGES', INITIAL_RESOURCE_PROFILE.maxEdges + 1);
  }, VerificationBudgetExhaustedError, 'Should throw atomic failure');
  assert(budget.getConsumed('EDGES') === 0, 'Consumed should be 0 on atomic failure');
}

console.log('VerificationBudget tests passed.');
