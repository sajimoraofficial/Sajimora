/**
 * @file JavaHistoricalGitEvaluation.test.ts
 * Real historical Git evaluation suite verifying compatibility certification across
 * realistic changes distilled from major Java ecosystems: Google Guava, Jackson, Spring, Netty, Vavr, and Square.
 */

import { describe, it, expect } from 'vitest';
import { runJavaAnalysis } from '../../../../scripts/sajimora/analyzeJava';

describe('Java Historical Git Evaluation Suite', () => {
  it('Ecosystem 1: Google Guava - Public method overload removal (checkNotNull)', () => {
    const res = runJavaAnalysis({
      repoId: 'guava-eval',
      historicalFiles: {
        'pom.xml': '<project><groupId>com.google.common</groupId><artifactId>guava</artifactId></project>',
        'src/com/google/common/base/Preconditions.java': `
package com.google.common.base;
public final class Preconditions {
  public static <T> T checkNotNull(T reference) { return reference; }
  public static <T> T checkNotNull(T reference, String errorMessageTemplate, Object p1) { return reference; }
}`,
        'src/com/google/common/collect/ImmutableList.java': `
package com.google.common.collect;
import static com.google.common.base.Preconditions.checkNotNull;
public class ImmutableList {
  public void add(Object elem, int idx) {
    checkNotNull(elem, "at index %s", idx);
  }
}`,
        'src/com/google/common/cache/LocalCache.java': `
package com.google.common.cache;
import com.google.common.base.Preconditions;
public class LocalCache {
  public Object get(Object key) {
    return Preconditions.checkNotNull(key);
  }
}`
      },
      candidateFiles: {
        'pom.xml': '<project><groupId>com.google.common</groupId><artifactId>guava</artifactId></project>',
        'src/com/google/common/base/Preconditions.java': `
package com.google.common.base;
public final class Preconditions {
  public static <T> T checkNotNull(T reference) { return reference; }
  // 3-arg overload removed!
}`,
        'src/com/google/common/collect/ImmutableList.java': `
package com.google.common.collect;
import static com.google.common.base.Preconditions.checkNotNull;
public class ImmutableList {
  public void add(Object elem, int idx) {
    checkNotNull(elem, "at index %s", idx);
  }
}`,
        'src/com/google/common/cache/LocalCache.java': `
package com.google.common.cache;
import com.google.common.base.Preconditions;
public class LocalCache {
  public Object get(Object key) {
    return Preconditions.checkNotNull(key);
  }
}`
      }
    });

    const certs = res.consumerCertificates ?? [];
    expect(certs).toHaveLength(2);

    const listCert = certs.find(c => c.consumerFqcn === 'com.google.common.collect.ImmutableList');
    expect(listCert).toBeDefined();
    expect(listCert?.sourceCompatibility).toBe('INCOMPATIBLE');
    expect(listCert?.binaryCompatibility).toBe('INCOMPATIBLE');

    const cacheCert = certs.find(c => c.consumerFqcn === 'com.google.common.cache.LocalCache');
    expect(cacheCert).toBeDefined();
    expect(cacheCert?.sourceCompatibility).toBe('COMPATIBLE');
    expect(cacheCert?.binaryCompatibility).toBe('COMPATIBLE');
  });

  it('Ecosystem 2: Netty - Interface abstract method addition with abstract class exemption', () => {
    const res = runJavaAnalysis({
      repoId: 'netty-eval',
      historicalFiles: {
        'pom.xml': '<project><groupId>io.netty</groupId><artifactId>netty-buffer</artifactId></project>',
        'src/io/netty/buffer/ByteBuf.java': `
package io.netty.buffer;
public interface ByteBuf {
  int capacity();
}`,
        'src/io/netty/buffer/AbstractByteBuf.java': `
package io.netty.buffer;
public abstract class AbstractByteBuf implements ByteBuf {
  public int capacity() { return 1024; }
}`,
        'src/io/netty/buffer/UnpooledDirectByteBuf.java': `
package io.netty.buffer;
public class UnpooledDirectByteBuf extends AbstractByteBuf {
  public void allocate() {}
}`
      },
      candidateFiles: {
        'pom.xml': '<project><groupId>io.netty</groupId><artifactId>netty-buffer</artifactId></project>',
        'src/io/netty/buffer/ByteBuf.java': `
package io.netty.buffer;
public interface ByteBuf {
  int capacity();
  int maxFastWritableBytes();
}`,
        'src/io/netty/buffer/AbstractByteBuf.java': `
package io.netty.buffer;
public abstract class AbstractByteBuf implements ByteBuf {
  public int capacity() { return 1024; }
}`,
        'src/io/netty/buffer/UnpooledDirectByteBuf.java': `
package io.netty.buffer;
public class UnpooledDirectByteBuf extends AbstractByteBuf {
  public void allocate() {}
}`
      }
    });

    const certs = res.consumerCertificates ?? [];
    const abstractCert = certs.find(c => c.consumerFqcn === 'io.netty.buffer.AbstractByteBuf');
    expect(abstractCert).toBeDefined();
    expect(abstractCert?.sourceCompatibility).toBe('COMPATIBLE');
    expect(abstractCert?.binaryCompatibility).toBe('COMPATIBLE');

    const concreteCert = certs.find(c => c.consumerFqcn === 'io.netty.buffer.UnpooledDirectByteBuf');
    expect(concreteCert).toBeDefined();
    expect(concreteCert?.sourceCompatibility).toBe('INCOMPATIBLE');
    expect(concreteCert?.binaryCompatibility).toBe('COMPATIBLE');
  });

  it('Ecosystem 3: Spring Framework - Class made final breaking subclass vs caller', () => {
    const res = runJavaAnalysis({
      repoId: 'spring-eval',
      historicalFiles: {
        'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId></project>',
        'src/org/springframework/context/GenericApplicationContext.java': `
package org.springframework.context;
public class GenericApplicationContext {
  public void refresh() {}
}`,
        'src/org/springframework/context/StaticApplicationContext.java': `
package org.springframework.context;
public class StaticApplicationContext extends GenericApplicationContext {
  public void init() { refresh(); }
}`,
        'src/org/springframework/context/ContextConsumer.java': `
package org.springframework.context;
public class ContextConsumer {
  public void start() {
    GenericApplicationContext ctx = new GenericApplicationContext();
    ctx.refresh();
  }
}`
      },
      candidateFiles: {
        'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId></project>',
        'src/org/springframework/context/GenericApplicationContext.java': `
package org.springframework.context;
public final class GenericApplicationContext {
  public void refresh() {}
}`,
        'src/org/springframework/context/StaticApplicationContext.java': `
package org.springframework.context;
public class StaticApplicationContext extends GenericApplicationContext {
  public void init() { refresh(); }
}`,
        'src/org/springframework/context/ContextConsumer.java': `
package org.springframework.context;
public class ContextConsumer {
  public void start() {
    GenericApplicationContext ctx = new GenericApplicationContext();
    ctx.refresh();
  }
}`
      }
    });

    const certs = res.consumerCertificates ?? [];
    const staticCert = certs.find(c => c.consumerFqcn === 'org.springframework.context.StaticApplicationContext');
    expect(staticCert).toBeDefined();
    expect(staticCert?.sourceCompatibility).toBe('INCOMPATIBLE');
    expect(staticCert?.binaryCompatibility).toBe('INCOMPATIBLE');

    const consumerCert = certs.find(c => c.consumerFqcn === 'org.springframework.context.ContextConsumer');
    expect(consumerCert).toBeDefined();
    expect(consumerCert?.sourceCompatibility).toBe('COMPATIBLE');
    expect(consumerCert?.binaryCompatibility).toBe('COMPATIBLE');
  });

  it('Ecosystem 4: Square Retrofit - Overload addition with call-site ambiguity', () => {
    const res = runJavaAnalysis({
      repoId: 'retrofit-eval',
      historicalFiles: {
        'pom.xml': '<project><groupId>com.squareup.retrofit2</groupId><artifactId>retrofit</artifactId></project>',
        'src/com/acme/ApiClient.java': `
package com.acme;
public class ApiClient {
  public void query(String param) {}
}`,
        'src/com/acme/Consumer.java': `
package com.acme;
public class Consumer {
  public void test(ApiClient client) {
    client.query(null);
  }
}`
      },
      candidateFiles: {
        'pom.xml': '<project><groupId>com.squareup.retrofit2</groupId><artifactId>retrofit</artifactId></project>',
        'src/com/acme/ApiClient.java': `
package com.acme;
public class ApiClient {
  public void query(String param) {}
  public void query(StringBuilder param) {}
}`,
        'src/com/acme/Consumer.java': `
package com.acme;
public class Consumer {
  public void test(ApiClient client) {
    client.query(null);
  }
}`
      }
    });

    const certs = res.consumerCertificates ?? [];
    const consumerCert = certs.find(c => c.consumerFqcn === 'com.acme.Consumer');
    expect(consumerCert).toBeDefined();
    expect(consumerCert?.sourceCompatibility).toBe('INCOMPATIBLE');
    expect(consumerCert?.binaryCompatibility).toBe('COMPATIBLE');
  });
});
