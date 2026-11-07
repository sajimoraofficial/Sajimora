/**
 * @file JavaAdvisoryBenchmark.ts
 * Validation Benchmark Suite for Java Advisory Track — Sajimora Phase J-6.
 *
 * Implements casebgoal.md §Phase 9 and java_language_track_architecture.md §Phase J-6:
 *   - Class rename (Case-B identity change, unmigrated breaking and migrated preserved)
 *   - Method removal
 *   - Parameter type change (widened / narrowed)
 *   - Visibility narrowing (method, field, class)
 *   - Field removal
 *   - Annotation change (class @Deprecated, method annotations)
 *   - Inner class changes (inner method removal, inner class removal, inner additive)
 *   - Overload changes (additive overload)
 *   - Return type change
 *   - Interface implementation changes
 *   - Record component removal
 *   - Enum constant removal
 *   - Generics type bounds narrowing
 *   - Same-package and wildcard import consumers
 *   - Unresolved external dependencies (fail-closed)
 *   - Internal implementation refactoring (preserved)
 *
 * Measures:
 *   - consumer discovery recall
 *   - true-positive rate (precision on violations)
 *   - false-positive rate
 *   - false-negative rate
 *   - unresolved rate
 *   - deterministic repeatability
 *   - runtime
 *   - peak RSS
 */

import {
  AdvisoryJavaImpactAnalyzer,
  JavaAdvisoryBenchmarkCase,
  JavaAdvisoryBenchmarkCaseResult,
  JavaAdvisoryBenchmarkReport,
  runJavaAdvisoryBenchmark
} from './JavaImpactAnalyzer';

export {
  JavaAdvisoryBenchmarkCase,
  JavaAdvisoryBenchmarkCaseResult,
  JavaAdvisoryBenchmarkReport,
  runJavaAdvisoryBenchmark
};

export type JavaBenchmarkCategory =
  | 'class-rename'
  | 'method-removal'
  | 'parameter-type-change'
  | 'visibility-narrowing'
  | 'field-removal'
  | 'annotation-change'
  | 'inner-class'
  | 'overload'
  | 'return-type'
  | 'interface'
  | 'record-enum'
  | 'generics'
  | 'same-package'
  | 'wildcard-import'
  | 'preserved-additive'
  | 'unresolved';

export interface JavaBenchmarkCaseExtended extends JavaAdvisoryBenchmarkCase {
  readonly category: JavaBenchmarkCategory;
  readonly description: string;
}

/**
 * The standard 24-case benchmark suite for Phase J-6.
 */
export const JAVA_STANDARD_BENCHMARK_CASES: readonly JavaBenchmarkCaseExtended[] = [
  // ---------------------------------------------------------------------------
  // 1. Class rename (unmigrated consumer -> LIKELY_VIOLATED)
  // ---------------------------------------------------------------------------
  {
    name: 'class-rename-unmigrated-breaking',
    category: 'class-rename',
    description: 'Renaming OrderService to PurchaseService while consumer still imports OrderService',
    tags: ['class-rename', 'breaking', 'case-b'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-rename-1',
        files: {
          'src/com/acme/OrderService.java': `
            package com.acme;
            public class OrderService {
              public void processOrder(String id) {}
            }
          `,
          'src/com/acme/OrderController.java': `
            package com.acme;
            import com.acme.OrderService;
            public class OrderController {
              private OrderService service;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-rename-1',
        files: {
          'src/com/acme/PurchaseService.java': `
            package com.acme;
            public class PurchaseService {
              public void processOrder(String id) {}
            }
          `,
          'src/com/acme/OrderController.java': `
            package com.acme;
            import com.acme.OrderService;
            public class OrderController {
              private OrderService service;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 2. Class rename (migrated consumer -> LIKELY_PRESERVED)
  // ---------------------------------------------------------------------------
  {
    name: 'class-rename-migrated-preserved',
    category: 'class-rename',
    description: 'Renaming OrderService to PurchaseService with consumer updated to PurchaseService',
    tags: ['class-rename', 'preserved', 'case-b'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-rename-2',
        files: {
          'src/com/acme/OrderService.java': `
            package com.acme;
            public class OrderService {
              public void processOrder(String id) {}
            }
          `,
          'src/com/acme/OrderController.java': `
            package com.acme;
            import com.acme.OrderService;
            public class OrderController {
              private OrderService service;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-rename-2',
        files: {
          'src/com/acme/PurchaseService.java': `
            package com.acme;
            public class PurchaseService {
              public void processOrder(String id) {}
            }
          `,
          'src/com/acme/OrderController.java': `
            package com.acme;
            import com.acme.PurchaseService;
            public class OrderController {
              private PurchaseService service;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 3. Method removal (breaking change)
  // ---------------------------------------------------------------------------
  {
    name: 'method-removal-breaking',
    category: 'method-removal',
    description: 'Removing execute() method from Provider class',
    tags: ['method-removal', 'breaking', 'method'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-method-rem',
        files: {
          'src/com/acme/Provider.java': `
            package com.acme;
            public class Provider {
              public void execute() {}
            }
          `,
          'src/com/acme/Client.java': `
            package com.acme;
            import com.acme.Provider;
            public class Client {
              private Provider provider;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-method-rem',
        files: {
          'src/com/acme/Provider.java': `
            package com.acme;
            public class Provider {}
          `,
          'src/com/acme/Client.java': `
            package com.acme;
            import com.acme.Provider;
            public class Client {
              private Provider provider;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 4. Parameter type change (widened / incompatible)
  // ---------------------------------------------------------------------------
  {
    name: 'parameter-type-changed-breaking',
    category: 'parameter-type-change',
    description: 'Changing method parameter from String to Integer',
    tags: ['parameter-type-change', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-param-type',
        files: {
          'src/com/acme/Calculator.java': `
            package com.acme;
            public class Calculator {
              public void compute(String input) {}
            }
          `,
          'src/com/acme/App.java': `
            package com.acme;
            import com.acme.Calculator;
            public class App {
              public void run(Calculator calc) {
                calc.compute("test");
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-param-type',
        files: {
          'src/com/acme/Calculator.java': `
            package com.acme;
            public class Calculator {
              public void compute(Integer input) {}
            }
          `,
          'src/com/acme/App.java': `
            package com.acme;
            import com.acme.Calculator;
            public class App {
              public void run(Calculator calc) {
                calc.compute("test");
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 5. Parameter added without default (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'parameter-added-breaking',
    category: 'parameter-type-change',
    description: 'Adding a required second parameter to send()',
    tags: ['parameter-type-change', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-param-add',
        files: {
          'src/com/acme/Sender.java': `
            package com.acme;
            public class Sender {
              public void send(String payload) {}
            }
          `,
          'src/com/acme/Client.java': `
            package com.acme;
            import com.acme.Sender;
            public class Client {
              public void trigger(Sender s) {
                s.send("msg");
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-param-add',
        files: {
          'src/com/acme/Sender.java': `
            package com.acme;
            public class Sender {
              public void send(String payload, int timeoutMs) {}
            }
          `,
          'src/com/acme/Client.java': `
            package com.acme;
            import com.acme.Sender;
            public class Client {
              public void trigger(Sender s) {
                s.send("msg");
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 6. Visibility narrowing: method (public -> private)
  // ---------------------------------------------------------------------------
  {
    name: 'visibility-narrowing-method-breaking',
    category: 'visibility-narrowing',
    description: 'Narrowing method visibility from public to private',
    tags: ['visibility-narrowing', 'breaking', 'method'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-vis-method',
        files: {
          'src/com/acme/Service.java': `
            package com.acme;
            public class Service {
              public void start() {}
            }
          `,
          'src/com/other/Consumer.java': `
            package com.other;
            import com.acme.Service;
            public class Consumer {
              private Service s;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-vis-method',
        files: {
          'src/com/acme/Service.java': `
            package com.acme;
            public class Service {
              private void start() {}
            }
          `,
          'src/com/other/Consumer.java': `
            package com.other;
            import com.acme.Service;
            public class Consumer {
              private Service s;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 7. Visibility narrowing: field (public -> package-private)
  // ---------------------------------------------------------------------------
  {
    name: 'visibility-narrowing-field-breaking',
    category: 'visibility-narrowing',
    description: 'Narrowing field visibility from public to package-private for external package consumer',
    tags: ['visibility-narrowing', 'breaking', 'field'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-vis-field',
        files: {
          'src/com/acme/Config.java': `
            package com.acme;
            public class Config {
              public int timeoutMs;
            }
          `,
          'src/com/external/Client.java': `
            package com.external;
            import com.acme.Config;
            public class Client {
              private Config cfg;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-vis-field',
        files: {
          'src/com/acme/Config.java': `
            package com.acme;
            public class Config {
              int timeoutMs;
            }
          `,
          'src/com/external/Client.java': `
            package com.external;
            import com.acme.Config;
            public class Client {
              private Config cfg;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 8. Visibility narrowing: class (public -> package-private)
  // ---------------------------------------------------------------------------
  {
    name: 'visibility-narrowing-class-breaking',
    category: 'visibility-narrowing',
    description: 'Narrowing class visibility from public to package-private for external consumer',
    tags: ['visibility-narrowing', 'breaking', 'class'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-vis-class',
        files: {
          'src/com/acme/PublicHelper.java': `
            package com.acme;
            public class PublicHelper {}
          `,
          'src/com/other/App.java': `
            package com.other;
            import com.acme.PublicHelper;
            public class App {
              private PublicHelper h;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-vis-class',
        files: {
          'src/com/acme/PublicHelper.java': `
            package com.acme;
            class PublicHelper {}
          `,
          'src/com/other/App.java': `
            package com.other;
            import com.acme.PublicHelper;
            public class App {
              private PublicHelper h;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 9. Field removal (breaking change)
  // ---------------------------------------------------------------------------
  {
    name: 'field-removal-breaking',
    category: 'field-removal',
    description: 'Removing public constant field MAX_ITEMS',
    tags: ['field-removal', 'breaking', 'field'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-field-rem',
        files: {
          'src/com/acme/Constants.java': `
            package com.acme;
            public class Constants {
              public static final int MAX_ITEMS = 100;
            }
          `,
          'src/com/app/Main.java': `
            package com.app;
            import com.acme.Constants;
            public class Main {}
          `
        }
      },
      candidate: {
        commitSha: 'c-field-rem',
        files: {
          'src/com/acme/Constants.java': `
            package com.acme;
            public class Constants {}
          `,
          'src/com/app/Main.java': `
            package com.app;
            import com.acme.Constants;
            public class Main {}
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 10. Annotation change: class @Deprecated (preserved)
  // ---------------------------------------------------------------------------
  {
    name: 'annotation-change-deprecated-preserved',
    category: 'annotation-change',
    description: 'Adding @Deprecated annotation to class does not break compilation',
    tags: ['annotation-change', 'preserved'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-anno-1',
        files: {
          'src/com/acme/LegacyService.java': `
            package com.acme;
            public class LegacyService {
              public void doOldThing() {}
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.LegacyService;
            public class App {
              private LegacyService svc;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-anno-1',
        files: {
          'src/com/acme/LegacyService.java': `
            package com.acme;
            @Deprecated
            public class LegacyService {
              public void doOldThing() {}
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.LegacyService;
            public class App {
              private LegacyService svc;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 11. Annotation change: method @SuppressWarnings (preserved)
  // ---------------------------------------------------------------------------
  {
    name: 'annotation-change-method-preserved',
    category: 'annotation-change',
    description: 'Adding @SuppressWarnings to method does not break callers',
    tags: ['annotation-change', 'preserved'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-anno-2',
        files: {
          'src/com/acme/Service.java': `
            package com.acme;
            public class Service {
              public void query() {}
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Service;
            public class App {
              private Service s;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-anno-2',
        files: {
          'src/com/acme/Service.java': `
            package com.acme;
            public class Service {
              @SuppressWarnings
              public void query() {}
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Service;
            public class App {
              private Service s;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 12. Inner class: method removal (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'inner-class-method-removal-breaking',
    category: 'inner-class',
    description: 'Removing build() method from static inner Builder class',
    tags: ['inner-class', 'breaking', 'method'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-inner-1',
        files: {
          'src/com/acme/Widget.java': `
            package com.acme;
            public class Widget {
              public static class Builder {
                public Widget build() { return new Widget(); }
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Widget.Builder;
            public class App {
              public void run() {
                Builder b = new Builder();
                b.build();
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-inner-1',
        files: {
          'src/com/acme/Widget.java': `
            package com.acme;
            public class Widget {
              public static class Builder {}
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Widget.Builder;
            public class App {
              public void run() {
                Builder b = new Builder();
                b.build();
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 13. Inner class: class removal (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'inner-class-removal-breaking',
    category: 'inner-class',
    description: 'Removing static inner Config class entirely',
    tags: ['inner-class', 'breaking', 'class'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-inner-2',
        files: {
          'src/com/acme/Server.java': `
            package com.acme;
            public class Server {
              public static class Config {
                public int port;
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Server.Config;
            public class App {
              private Config cfg;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-inner-2',
        files: {
          'src/com/acme/Server.java': `
            package com.acme;
            public class Server {}
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Server.Config;
            public class App {
              private Config cfg;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 14. Inner class: additive method (preserved)
  // ---------------------------------------------------------------------------
  {
    name: 'inner-class-additive-preserved',
    category: 'inner-class',
    description: 'Adding a new method to an inner Builder class is compatible',
    tags: ['inner-class', 'preserved', 'additive'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-inner-3',
        files: {
          'src/com/acme/Widget.java': `
            package com.acme;
            public class Widget {
              public static class Builder {
                public Widget build() { return new Widget(); }
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Widget.Builder;
            public class App {
              private Builder b;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-inner-3',
        files: {
          'src/com/acme/Widget.java': `
            package com.acme;
            public class Widget {
              public static class Builder {
                public Widget build() { return new Widget(); }
                public Builder withTimeout(int ms) { return this; }
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Widget.Builder;
            public class App {
              private Builder b;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 15. Method overload added (preserved)
  // ---------------------------------------------------------------------------
  {
    name: 'method-overload-added-preserved',
    category: 'overload',
    description: 'Adding an overloaded variant of find() method is backwards compatible',
    tags: ['overload', 'preserved', 'additive'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-overload',
        files: {
          'src/com/acme/Repo.java': `
            package com.acme;
            public class Repo {
              public String find(String id) { return id; }
            }
          `,
          'src/com/app/Client.java': `
            package com.app;
            import com.acme.Repo;
            public class Client {
              private Repo r;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-overload',
        files: {
          'src/com/acme/Repo.java': `
            package com.acme;
            public class Repo {
              public String find(String id) { return id; }
              public String find(String id, boolean includeDeleted) { return id; }
            }
          `,
          'src/com/app/Client.java': `
            package com.app;
            import com.acme.Repo;
            public class Client {
              private Repo r;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 16. Return type changed (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'method-return-type-changed-breaking',
    category: 'return-type',
    description: 'Changing method return type from String to int',
    tags: ['return-type', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-ret-type',
        files: {
          'src/com/acme/DataStore.java': `
            package com.acme;
            public class DataStore {
              public String getStatus() { return "OK"; }
            }
          `,
          'src/com/app/Monitor.java': `
            package com.app;
            import com.acme.DataStore;
            public class Monitor {
              public void inspect(DataStore ds) {
                ds.getStatus();
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-ret-type',
        files: {
          'src/com/acme/DataStore.java': `
            package com.acme;
            public class DataStore {
              public int getStatus() { return 200; }
            }
          `,
          'src/com/app/Monitor.java': `
            package com.app;
            import com.acme.DataStore;
            public class Monitor {
              public void inspect(DataStore ds) {
                ds.getStatus();
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 17. Interface method added (breaking for implementor)
  // ---------------------------------------------------------------------------
  {
    name: 'interface-method-added-breaking',
    category: 'interface',
    description: 'Adding a non-default method to an interface breaks implementing classes',
    tags: ['interface', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-iface',
        files: {
          'src/com/acme/Worker.java': `
            package com.acme;
            public interface Worker {
              void execute();
            }
          `,
          'src/com/acme/BasicWorker.java': `
            package com.acme;
            public class BasicWorker implements Worker {
              public void execute() {}
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-iface',
        files: {
          'src/com/acme/Worker.java': `
            package com.acme;
            public interface Worker {
              void execute();
              void abort();
            }
          `,
          'src/com/acme/BasicWorker.java': `
            package com.acme;
            public class BasicWorker implements Worker {
              public void execute() {}
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 18. Record component removed (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'record-component-removed-breaking',
    category: 'record-enum',
    description: 'Removing component from record definition changes constructor and accessors',
    tags: ['record', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-record',
        files: {
          'src/com/acme/Point.java': `
            package com.acme;
            public record Point(int x, int y) {}
          `,
          'src/com/app/Renderer.java': `
            package com.app;
            import com.acme.Point;
            public class Renderer {
              private Point p;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-record',
        files: {
          'src/com/acme/Point.java': `
            package com.acme;
            public record Point(int x) {}
          `,
          'src/com/app/Renderer.java': `
            package com.app;
            import com.acme.Point;
            public class Renderer {
              private Point p;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 19. Enum constant removed (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'enum-constant-removed-breaking',
    category: 'record-enum',
    description: 'Removing constant ARCHIVED from enum',
    tags: ['enum', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-enum',
        files: {
          'src/com/acme/Status.java': `
            package com.acme;
            public enum Status {
              ACTIVE, INACTIVE, ARCHIVED
            }
          `,
          'src/com/app/Tracker.java': `
            package com.app;
            import com.acme.Status;
            public class Tracker {
              private Status s;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-enum',
        files: {
          'src/com/acme/Status.java': `
            package com.acme;
            public enum Status {
              ACTIVE, INACTIVE
            }
          `,
          'src/com/app/Tracker.java': `
            package com.app;
            import com.acme.Status;
            public class Tracker {
              private Status s;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 20. Generics bounds narrowed (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'generics-bound-narrowed-breaking',
    category: 'generics',
    description: 'Narrowing type parameter from unbounded T to T extends Number',
    tags: ['generics', 'breaking'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-generic',
        files: {
          'src/com/acme/Container.java': `
            package com.acme;
            public class Container {
              public void hold(Object item) {}
            }
          `,
          'src/com/app/BoxApp.java': `
            package com.app;
            import com.acme.Container;
            public class BoxApp {
              public void pack(Container c) {
                c.hold("string");
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-generic',
        files: {
          'src/com/acme/Container.java': `
            package com.acme;
            public class Container {
              public void hold(Number item) {}
            }
          `,
          'src/com/app/BoxApp.java': `
            package com.app;
            import com.acme.Container;
            public class BoxApp {
              public void pack(Container c) {
                c.hold("string");
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 21. Same package consumer (breaking without explicit import)
  // ---------------------------------------------------------------------------
  {
    name: 'same-package-consumer-breaking',
    category: 'same-package',
    description: 'Method removed in helper class breaks same-package caller without import',
    tags: ['same-package', 'breaking', 'j-6'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-same-pkg',
        files: {
          'src/com/acme/InternalHelper.java': `
            package com.acme;
            public class InternalHelper {
              public static void assist() {}
            }
          `,
          'src/com/acme/MainService.java': `
            package com.acme;
            public class MainService {
              public void run() {
                InternalHelper.assist();
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-same-pkg',
        files: {
          'src/com/acme/InternalHelper.java': `
            package com.acme;
            public class InternalHelper {}
          `,
          'src/com/acme/MainService.java': `
            package com.acme;
            public class MainService {
              public void run() {
                InternalHelper.assist();
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 22. Wildcard import consumer (breaking)
  // ---------------------------------------------------------------------------
  {
    name: 'wildcard-import-consumer-breaking',
    category: 'wildcard-import',
    description: 'Consumer uses import com.acme.* and provider removes a method called by consumer',
    tags: ['wildcard-import', 'breaking', 'j-2'],
    expectedVerdict: 'LIKELY_VIOLATED',
    expectedConsumerCount: 1,
    input: {
      parent: {
        commitSha: 'p-wildcard',
        files: {
          'src/com/acme/PaymentGateway.java': `
            package com.acme;
            public class PaymentGateway {
              public void charge(int cents) {}
            }
          `,
          'src/com/app/Checkout.java': `
            package com.app;
            import com.acme.*;
            public class Checkout {
              public void pay(PaymentGateway gw) {
                gw.charge(500);
              }
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-wildcard',
        files: {
          'src/com/acme/PaymentGateway.java': `
            package com.acme;
            public class PaymentGateway {}
          `,
          'src/com/app/Checkout.java': `
            package com.app;
            import com.acme.*;
            public class Checkout {
              public void pay(PaymentGateway gw) {
                gw.charge(500);
              }
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 23. Internal implementation refactor (preserved)
  // ---------------------------------------------------------------------------
  {
    name: 'internal-implementation-refactor-preserved',
    category: 'preserved-additive',
    description: 'Rewriting method body for performance while keeping signature identical',
    tags: ['refactor', 'preserved'],
    expectedVerdict: 'LIKELY_PRESERVED',
    expectedConsumerCount: 0,
    input: {
      parent: {
        commitSha: 'p-refactor',
        files: {
          'src/com/acme/Sorter.java': `
            package com.acme;
            public class Sorter {
              public void sort(int[] arr) {
                // slow bubble sort
                for (int i = 0; i < arr.length; i++) {
                  for (int j = 0; j < arr.length - 1; j++) {
                    if (arr[j] > arr[j+1]) { int t = arr[j]; arr[j] = arr[j+1]; arr[j+1] = t; }
                  }
                }
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Sorter;
            public class App {
              private Sorter s;
            }
          `
        }
      },
      candidate: {
        commitSha: 'c-refactor',
        files: {
          'src/com/acme/Sorter.java': `
            package com.acme;
            public class Sorter {
              public void sort(int[] arr) {
                java.util.Arrays.sort(arr);
              }
            }
          `,
          'src/com/app/App.java': `
            package com.app;
            import com.acme.Sorter;
            public class App {
              private Sorter s;
            }
          `
        }
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 24. Unresolved external dependency (inconclusive / fail-closed)
  // ---------------------------------------------------------------------------
  {
    name: 'unresolved-external-dependency-inconclusive',
    category: 'unresolved',
    description: 'Sealed snapshot incomplete due to missing external jar or source files',
    tags: ['unresolved', 'inconclusive', 'fail-closed'],
    expectedVerdict: 'INCONCLUSIVE',
    expectedConsumerCount: 0,
    input: {
      parent: {
        commitSha: 'p-unresolved',
        files: {
          'src/com/acme/Api.java': `
            package com.acme;
            public class Api {
              public void call() {}
            }
          `
        },
        selection: {
          selectedFiles: 1,
          selectedBytes: 100,
          scannedFiles: 1,
          scannedBytes: 100,
          incompleteReasons: ['External dependency missing: org.springframework:spring-core:6.0.0']
        }
      },
      candidate: {
        commitSha: 'c-unresolved',
        files: {
          'src/com/acme/Api.java': `
            package com.acme;
            public class Api {}
          `
        },
        selection: {
          selectedFiles: 1,
          selectedBytes: 90,
          scannedFiles: 1,
          scannedBytes: 90,
          incompleteReasons: ['External dependency missing: org.springframework:spring-core:6.0.0']
        }
      }
    }
  }
];

/**
 * Executes the complete standard benchmark suite and returns the evaluation report.
 */
export function runStandardJavaBenchmark(
  analyzer = new AdvisoryJavaImpactAnalyzer(),
  customCases?: readonly JavaAdvisoryBenchmarkCase[]
): JavaAdvisoryBenchmarkReport {
  const cases = customCases ?? JAVA_STANDARD_BENCHMARK_CASES;
  return runJavaAdvisoryBenchmark(cases, analyzer);
}

/**
 * Filter standard cases by specific category.
 */
export function getStandardBenchmarkCasesByCategory(category: JavaBenchmarkCategory): readonly JavaBenchmarkCaseExtended[] {
  return JAVA_STANDARD_BENCHMARK_CASES.filter(c => c.category === category);
}

/**
 * Pretty-print benchmark report for CI / markdown summaries.
 */
export function renderJavaBenchmarkSummary(report: JavaAdvisoryBenchmarkReport): string {
  const m = report.metrics;
  const lines: string[] = [
    '# Sajimora Advisory Java Benchmark Report (Phase J-6)',
    `**Schema Version:** \`${report.schemaVersion}\``,
    `**Total Cases:** ${report.cases.length}`,
    '',
    '## Evaluation Metrics',
    '| Metric | Value | Target | Status |',
    '|---|---|---|---|',
    `| Consumer Discovery Recall | ${m.consumerDiscoveryRecall !== null ? (m.consumerDiscoveryRecall * 100).toFixed(1) + '%' : 'N/A'} | >= 95.0% | ${m.consumerDiscoveryRecall === null || m.consumerDiscoveryRecall >= 0.95 ? '✅ PASS' : '❌ FAIL'} |`,
    `| True Positive Rate (Precision) | ${m.truePositiveRate !== null ? (m.truePositiveRate * 100).toFixed(1) + '%' : 'N/A'} | 100.0% | ${m.truePositiveRate === 1.0 ? '✅ PASS' : '❌ FAIL'} |`,
    `| False Positive Rate | ${m.falsePositiveRate !== null ? (m.falsePositiveRate * 100).toFixed(1) + '%' : 'N/A'} | 0.0% | ${m.falsePositiveRate === 0.0 ? '✅ PASS' : '❌ FAIL'} |`,
    `| False Negative Rate | ${m.falseNegativeRate !== null ? (m.falseNegativeRate * 100).toFixed(1) + '%' : 'N/A'} | 0.0% | ${m.falseNegativeRate === 0.0 ? '✅ PASS' : '❌ FAIL'} |`,
    `| Deterministic Repeatability | ${(m.deterministicRepeatability * 100).toFixed(1)}% | 100.0% | ${m.deterministicRepeatability === 1.0 ? '✅ PASS' : '❌ FAIL'} |`,
    `| Unresolved (Fail-Closed) Rate | ${(m.unresolvedRate * 100).toFixed(1)}% | N/A | ℹ️ INFO |`,
    `| Total Execution Time | ${m.runtimeMs.toFixed(2)} ms | < 5000 ms | ${m.runtimeMs < 5000 ? '✅ PASS' : '⚠️ SLOW'} |`,
    `| Peak RSS Delta | ${(m.peakRssDeltaBytes / (1024 * 1024)).toFixed(2)} MB | < 250 MB | ${m.peakRssDeltaBytes < 250 * 1024 * 1024 ? '✅ PASS' : '⚠️ HIGH'} |`,
    '',
    '## Case Breakdown',
    '| Case Name | Expected | Actual | Consumers (Exp/Act) | Deterministic | Elapsed | Status |',
    '|---|---|---|---|---|---|---|'
  ];

  for (const c of report.cases) {
    const passed = c.expectedVerdict === c.actualVerdict && (c.expectedConsumerCount === null || c.actualConsumerCount >= c.expectedConsumerCount);
    lines.push(
      `| \`${c.name}\` | \`${c.expectedVerdict}\` | \`${c.actualVerdict}\` | ${c.expectedConsumerCount ?? '-'}/${c.actualConsumerCount} | ${c.deterministic ? '✓' : '✗'} | ${c.elapsedMs.toFixed(1)}ms | ${passed ? '✅' : '❌'} |`
    );
  }

  return lines.join('\n');
}
