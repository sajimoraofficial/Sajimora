/**
 * @file JavaGuardedAdditiveProofs.test.ts
 * Verification Suite for Guarded Additive Proofs & Unreachable Deletions (§5.1.2 & §5.1.3 Step 3).
 *
 * Verifies:
 *   1. Subtype collision: adding a superclass method collides with subclass weaker visibility => LIKELY_VIOLATED.
 *   2. Subtype collision: adding a superclass method collides with subclass incompatible return type => LIKELY_VIOLATED.
 *   3. Safe additive proof: adding a superclass method without subclass collision => LIKELY_PRESERVED.
 *   4. Unreachable deletion: deleting an unused member with zero repo references => LIKELY_PRESERVED.
 *   5. Guarded unreachable deletion: deleting an unused member on a framework-annotated class => INCONCLUSIVE (ABST_FRAMEWORK_REACHABLE).
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JavaSealedRevision
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Guarded Additive Proofs & Deletion Test Suite (§5.1.2 & §5.1.3) ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// ---------------------------------------------------------------------------
// Test 1: Subtype Collision — Weaker Access Privileges in Subclass
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p1',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          protected void execute(String msg) {}
        }
      `
    }
  };

  // Candidate adds public execute(String) to BaseService.
  // In Java: SubService now attempts to assign weaker access privileges (protected was public) => compile break!
  const candidate: JavaSealedRevision = {
    commitSha: 'c1',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
          public void execute(String msg) {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          protected void execute(String msg) {}
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Subtype collision with weaker visibility must be LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Must flag an inheritor impact as LIKELY_BROKEN');
  console.log('✓ Test 1: Subtype collision with weaker visibility passed');
}

// ---------------------------------------------------------------------------
// Test 2: Subtype Collision — Incompatible Return Type in Subclass
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p2',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          public String compute(int x) { return "" + x; }
        }
      `
    }
  };

  // Candidate adds public int compute(int x) to BaseService.
  // In Java: SubService.compute return type String is incompatible with int => compile break!
  const candidate: JavaSealedRevision = {
    commitSha: 'c2',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
          public int compute(int x) { return x; }
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          public String compute(int x) { return "" + x; }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Subtype collision with incompatible return type must be LIKELY_VIOLATED');
  const brokenImpact = res.impacts.find(i => i.classification === 'LIKELY_BROKEN');
  assert.ok(brokenImpact, 'Must flag an inheritor impact as LIKELY_BROKEN');
  console.log('✓ Test 2: Subtype collision with incompatible return type passed');
}

// ---------------------------------------------------------------------------
// Test 3: Safe Additive Addition Without Subclass Collision
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p3',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          public void doOtherWork() {}
        }
      `
    }
  };

  // Candidate adds non-conflicting public method to BaseService
  const candidate: JavaSealedRevision = {
    commitSha: 'c3',
    files: {
      'src/com/acme/BaseService.java': `
        package com.acme;
        public class BaseService {
          public void ping() {}
          public void execute(String msg) {}
        }
      `,
      'src/com/acme/SubService.java': `
        package com.acme;
        public class SubService extends BaseService {
          public void doOtherWork() {}
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Non-colliding method addition must be LIKELY_PRESERVED');
  console.log('✓ Test 3: Non-colliding method addition passed');
}

// ---------------------------------------------------------------------------
// Test 4: Provably Unreachable Deletion
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p4',
    files: {
      'src/com/acme/DeadCodeHelper.java': `
        package com.acme;
        public class DeadCodeHelper {
          public static void unusedUtility() {}
        }
      `,
      'src/com/acme/MainApp.java': `
        package com.acme;
        public class MainApp {
          public void run() {}
        }
      `
    }
  };

  // Candidate removes unused utility method; no callers or references in repo
  const candidate: JavaSealedRevision = {
    commitSha: 'c4',
    files: {
      'src/com/acme/DeadCodeHelper.java': `
        package com.acme;
        public class DeadCodeHelper {}
      `,
      'src/com/acme/MainApp.java': `
        package com.acme;
        public class MainApp {
          public void run() {}
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_PRESERVED', 'Unreachable deleted method with 0 references must be LIKELY_PRESERVED');
  console.log('✓ Test 4: Provably unreachable deletion passed');
}

// ---------------------------------------------------------------------------
// Test 5: Guarded Deletion on Framework-Managed Class
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p5',
    files: {
      'src/com/acme/PaymentService.java': `
        package com.acme;
        import org.springframework.stereotype.Service;

        @Service
        public class PaymentService {
          public void processPayment() {}
        }
      `
    }
  };

  // Candidate removes processPayment; no in-repo static callers exist, but class is @Service!
  const candidate: JavaSealedRevision = {
    commitSha: 'c5',
    files: {
      'src/com/acme/PaymentService.java': `
        package com.acme;
        import org.springframework.stereotype.Service;

        @Service
        public class PaymentService {}
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'INCONCLUSIVE', 'Deleted method on @Service class must demote to INCONCLUSIVE');
  assert.ok(res.abstentionCodes.includes('ABST_FRAMEWORK_REACHABLE'), 'Must emit ABST_FRAMEWORK_REACHABLE');
  console.log('✓ Test 5: Guarded deletion on framework class passed');
}

console.log('\n--- ALL JAVA GUARDED ADDITIVE PROOFS TESTS PASSED ---');
