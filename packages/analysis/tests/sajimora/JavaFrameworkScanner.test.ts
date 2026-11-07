/**
 * @file JavaFrameworkScanner.test.ts
 * Verification Suite for Java Framework & Descriptor Scanner (§4.4 Step 2.5).
 *
 * Verifies:
 *   1. Spring/CDI/Jakarta lifecycle annotations (@Bean, @EventListener, @Service, @Component).
 *   2. Service Provider Interface (SPI) registrations in META-INF/services/.
 *   3. Enterprise XML descriptors (portlet.xml, Spring <bean class="...">).
 *   4. Attribution: Inconclusive cases emit ABST_FRAMEWORK_REACHABLE.
 *   5. Precedence: Direct in-repo breaking calls still evaluate to LIKELY_VIOLATED (Pillar 2).
 */

import assert from 'node:assert/strict';
import {
  AdvisoryJavaImpactAnalyzer,
  JavaSealedRevision
} from '../../src/sajimora/advisory';

console.log('--- Starting Java Framework & Descriptor Scanner Test Suite (§4.4) ---');

const analyzer = new AdvisoryJavaImpactAnalyzer();

// ---------------------------------------------------------------------------
// Test 1: @Bean Method Changed Without In-Repo Caller
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p1',
    files: {
      'src/com/acme/AppConfig.java': `
        package com.acme;
        import org.springframework.context.annotation.Bean;
        import org.springframework.context.annotation.Configuration;

        @Configuration
        public class AppConfig {
          @Bean
          public DataSource dataSource() {
            return new DataSource();
          }
        }
      `,
      'src/com/acme/DataSource.java': `
        package com.acme;
        public class DataSource {}
      `
    }
  };

  // Candidate changes return type of @Bean method (runtime break for Spring DI container)
  const candidate: JavaSealedRevision = {
    commitSha: 'c1',
    files: {
      'src/com/acme/AppConfig.java': `
        package com.acme;
        import org.springframework.context.annotation.Bean;
        import org.springframework.context.annotation.Configuration;

        @Configuration
        public class AppConfig {
          @Bean
          public Object dataSource() {
            return new Object();
          }
        }
      `,
      'src/com/acme/DataSource.java': `
        package com.acme;
        public class DataSource {}
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'INCONCLUSIVE', 'Changed @Bean method without in-repo callers must demote to INCONCLUSIVE');
  assert.ok(res.abstentionCodes.includes('ABST_FRAMEWORK_REACHABLE'), 'Must emit ABST_FRAMEWORK_REACHABLE');
  console.log('✓ Test 1: @Bean annotation reachability passed');
}

// ---------------------------------------------------------------------------
// Test 2: @EventListener Method Changed Without In-Repo Caller
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p2',
    files: {
      'src/com/acme/OrderListener.java': `
        package com.acme;
        import org.springframework.context.event.EventListener;
        import org.springframework.stereotype.Component;

        @Component
        public class OrderListener {
          @EventListener
          public void onOrderPlaced(OrderEvent event) {}
        }
      `,
      'src/com/acme/OrderEvent.java': `
        package com.acme;
        public class OrderEvent {}
      `
    }
  };

  const candidate: JavaSealedRevision = {
    commitSha: 'c2',
    files: {
      'src/com/acme/OrderListener.java': `
        package com.acme;
        import org.springframework.context.event.EventListener;
        import org.springframework.stereotype.Component;

        @Component
        public class OrderListener {
          @EventListener
          public void onOrderPlaced() {}
        }
      `,
      'src/com/acme/OrderEvent.java': `
        package com.acme;
        public class OrderEvent {}
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'INCONCLUSIVE', 'Changed @EventListener method without in-repo caller must demote to INCONCLUSIVE');
  assert.ok(res.abstentionCodes.includes('ABST_FRAMEWORK_REACHABLE'), 'Must emit ABST_FRAMEWORK_REACHABLE');
  console.log('✓ Test 2: @EventListener annotation reachability passed');
}

// ---------------------------------------------------------------------------
// Test 3: SPI Registration in META-INF/services/
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p3',
    files: {
      'src/com/acme/PluginService.java': `
        package com.acme;
        public class PluginService {
          public void init(String config) {}
        }
      `,
      'META-INF/services/com.acme.PluginService': `
        com.acme.PluginService
      `
    }
  };

  // Candidate removes init(String) parameter
  const candidate: JavaSealedRevision = {
    commitSha: 'c3',
    files: {
      'src/com/acme/PluginService.java': `
        package com.acme;
        public class PluginService {
          public void init() {}
        }
      `,
      'META-INF/services/com.acme.PluginService': `
        com.acme.PluginService
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'INCONCLUSIVE', 'Changed class registered in META-INF/services must demote to INCONCLUSIVE');
  assert.ok(res.abstentionCodes.includes('ABST_FRAMEWORK_REACHABLE'), 'Must emit ABST_FRAMEWORK_REACHABLE');
  console.log('✓ Test 3: SPI descriptor reachability passed');
}

// ---------------------------------------------------------------------------
// Test 4: Enterprise XML Descriptor (portlet.xml & Spring <bean>)
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p4',
    files: {
      'src/com/acme/portlet/MyCustomPortlet.java': `
        package com.acme.portlet;
        public class MyCustomPortlet {
          public void doView(String req, String resp) {}
        }
      `,
      'WEB-INF/portlet.xml': `
        <portlet-app>
          <portlet>
            <portlet-name>custom_portlet</portlet-name>
            <portlet-class>com.acme.portlet.MyCustomPortlet</portlet-class>
          </portlet>
        </portlet-app>
      `
    }
  };

  // Candidate removes parameter from doView
  const candidate: JavaSealedRevision = {
    commitSha: 'c4',
    files: {
      'src/com/acme/portlet/MyCustomPortlet.java': `
        package com.acme.portlet;
        public class MyCustomPortlet {
          public void doView() {}
        }
      `,
      'WEB-INF/portlet.xml': `
        <portlet-app>
          <portlet>
            <portlet-name>custom_portlet</portlet-name>
            <portlet-class>com.acme.portlet.MyCustomPortlet</portlet-class>
          </portlet>
        </portlet-app>
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'INCONCLUSIVE', 'Changed class registered in portlet.xml must demote to INCONCLUSIVE');
  assert.ok(res.abstentionCodes.includes('ABST_FRAMEWORK_REACHABLE'), 'Must emit ABST_FRAMEWORK_REACHABLE');
  console.log('✓ Test 4: XML descriptor reachability passed');
}

// ---------------------------------------------------------------------------
// Test 5: Direct In-Repo Broken Caller Outranks Unknowns (Pillar 2 Precedence)
// ---------------------------------------------------------------------------
{
  const parent: JavaSealedRevision = {
    commitSha: 'p5',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        import org.springframework.stereotype.Service;

        @Service
        public class OrderService {
          public void placeOrder(String id) {}
        }
      `,
      'src/com/acme/DirectCaller.java': `
        package com.acme;
        import com.acme.OrderService;

        public class DirectCaller {
          public void run() {
            OrderService svc = new OrderService();
            svc.placeOrder("123");
          }
        }
      `
    }
  };

  // Candidate breaks placeOrder parameter type
  const candidate: JavaSealedRevision = {
    commitSha: 'c5',
    files: {
      'src/com/acme/OrderService.java': `
        package com.acme;
        import org.springframework.stereotype.Service;

        @Service
        public class OrderService {
          public void placeOrder(int id) {}
        }
      `,
      'src/com/acme/DirectCaller.java': `
        package com.acme;
        import com.acme.OrderService;

        public class DirectCaller {
          public void run() {
            OrderService svc = new OrderService();
            svc.placeOrder("123");
          }
        }
      `
    }
  };

  const res = analyzer.analyze({ parent, candidate });
  assert.equal(res.verdict, 'LIKELY_VIOLATED', 'Direct in-repo breaking violation must outrank framework reachability (Pillar 2)');
  assert.ok(res.impacts.some(i => i.classification === 'LIKELY_BROKEN'), 'Must have LIKELY_BROKEN impact');
  console.log('✓ Test 5: Pillar 2 violation precedence over framework reachability passed');
}

console.log('\n--- ALL JAVA FRAMEWORK & DESCRIPTOR SCANNER TESTS PASSED ---');
