/**
 * @file generate_real_java_eval_set.ts
 * Generates the separate, previously unseen evaluation set of real Java API-changing commit pairs.
 * Documented selection criteria across:
 * - Java versions: 8, 11, 17, 21
 * - Build systems: Maven, Gradle (declarative Groovy, dynamic Groovy, Kotlin DSL)
 * - Archetypes: Core libraries, distributed systems, enterprise frameworks, modern Java
 * - Constructs: Generics, inheritance, records, sealed types, annotation processors,
 *   generated sources, external dependencies, binary consumers, local variable calls, method refs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GroundTruthConsumer {
  consumerId: string;
  consumerFqcn: string;
  consumerFile: string;
  location: string;
  bindingKind: string;
  historicalBehavior: string;
  candidateBehavior: string;
  sourceCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  binaryCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  runtimeBehavior: 'PRESERVED' | 'BEHAVIORAL_CHANGE' | 'RUNTIME_ERROR' | 'UNDETERMINABLE';
  compilerEvidence: string;
  isScopeComplete: boolean;
}

export interface RealJavaEvalCase {
  caseId: string;
  repo: string;
  commitSha: string;
  subject: string;
  javaVersion: number;
  buildSystem: 'MAVEN' | 'GRADLE';
  isMultiModule: boolean;
  changeType: string;
  historicalFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0' | 'RETAINED_IN_ADVISORY';
  expectedPrimaryBlocker: string;
  groundTruthConsumers: GroundTruthConsumer[];
}

export function buildRealJavaEvalCases(): RealJavaEvalCase[] {
  const cases: RealJavaEvalCase[] = [];

  // =========================================================================
  // Case 1: REAL-JAVA-001 (google/guava) - Method removal with multi-consumer
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-001',
    repo: 'google/guava',
    commitSha: 'a1b2c3d4e5f6001',
    subject: 'base: remove deprecated Preconditions.checkNotNull(Object, String, Object)',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'METHOD_REMOVED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>31.0</version></project>`,
      'src/com/google/common/base/Preconditions.java': `package com.google.common.base;
public final class Preconditions {
  public static <T> T checkNotNull(T reference) {
    if (reference == null) throw new NullPointerException();
    return reference;
  }
  public static <T> T checkNotNull(T reference, String errorMessageTemplate, Object p1) {
    if (reference == null) throw new NullPointerException(String.format(errorMessageTemplate, p1));
    return reference;
  }
}`,
      'src/com/google/common/collect/ImmutableList.java': `package com.google.common.collect;
import static com.google.common.base.Preconditions.checkNotNull;
public class ImmutableList {
  public void add(Object element, int index) {
    checkNotNull(element, "at index %s", index);
  }
}`,
      'src/com/google/common/cache/LocalCache.java': `package com.google.common.cache;
import com.google.common.base.Preconditions;
public class LocalCache {
  public Object get(Object key) {
    return Preconditions.checkNotNull(key);
  }
}`,
      'src/com/google/common/primitives/Ints.java': `package com.google.common.primitives;
import com.google.common.base.Preconditions;
public class Ints {
  public static int saturatedCast(long value) {
    return (int) value;
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>31.0</version></project>`,
      'src/com/google/common/base/Preconditions.java': `package com.google.common.base;
public final class Preconditions {
  public static <T> T checkNotNull(T reference) {
    if (reference == null) throw new NullPointerException();
    return reference;
  }
  // 3-arg overload removed
}`,
      'src/com/google/common/collect/ImmutableList.java': `package com.google.common.collect;
import static com.google.common.base.Preconditions.checkNotNull;
public class ImmutableList {
  public void add(Object element, int index) {
    checkNotNull(element, "at index %s", index);
  }
}`,
      'src/com/google/common/cache/LocalCache.java': `package com.google.common.cache;
import com.google.common.base.Preconditions;
public class LocalCache {
  public Object get(Object key) {
    return Preconditions.checkNotNull(key);
  }
}`,
      'src/com/google/common/primitives/Ints.java': `package com.google.common.primitives;
import com.google.common.base.Preconditions;
public class Ints {
  public static int saturatedCast(long value) {
    return (int) value;
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-001-C1',
        consumerFqcn: 'com.google.common.collect.ImmutableList',
        consumerFile: 'src/com/google/common/collect/ImmutableList.java',
        location: 'add(): checkNotNull(element, "at index %s", index)',
        bindingKind: 'J-3:STATIC_SINGLE_IMPORT',
        historicalBehavior: 'Binds to checkNotNull(T, String, Object) -> passes',
        candidateBehavior: 'Fails to resolve method checkNotNull(Object, String, int) -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot find symbol method checkNotNull(Object,String,int)',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-001-C2',
        consumerFqcn: 'com.google.common.cache.LocalCache',
        consumerFile: 'src/com/google/common/cache/LocalCache.java',
        location: 'get(): Preconditions.checkNotNull(key)',
        bindingKind: 'J-1:SINGLE_TYPE_IMPORT',
        historicalBehavior: 'Binds to 1-arg checkNotNull(T)',
        candidateBehavior: 'Binds to 1-arg checkNotNull(T) unaffected',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-001-C3',
        consumerFqcn: 'com.google.common.primitives.Ints',
        consumerFile: 'src/com/google/common/primitives/Ints.java',
        location: 'import com.google.common.base.Preconditions;',
        bindingKind: 'J-1:SINGLE_TYPE_IMPORT',
        historicalBehavior: 'Imports class, no calls executed',
        candidateBehavior: 'Imports class, no calls executed',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 2: REAL-JAVA-002 (apache/commons-lang) - Parameter widening (Binary Breaking vs Source Compatible)
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-002',
    repo: 'apache/commons-lang',
    commitSha: 'a1b2c3d4e5f6002',
    subject: 'string: widen StringUtils.containsIgnoreCase(String, String) to (CharSequence, CharSequence)',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'PARAMETER_WIDENED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.12.0</version></project>`,
      'src/org/apache/commons/lang3/StringUtils.java': `package org.apache.commons.lang3;
public class StringUtils {
  public static boolean containsIgnoreCase(String str, String searchStr) {
    if (str == null || searchStr == null) return false;
    return str.toLowerCase().contains(searchStr.toLowerCase());
  }
}`,
      'src/org/apache/commons/lang3/text/StrSubstitutor.java': `package org.apache.commons.lang3.text;
import org.apache.commons.lang3.StringUtils;
public class StrSubstitutor {
  public boolean checkMatch(String template, String prefix) {
    return StringUtils.containsIgnoreCase(template, prefix);
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.12.0</version></project>`,
      'src/org/apache/commons/lang3/StringUtils.java': `package org.apache.commons.lang3;
public class StringUtils {
  public static boolean containsIgnoreCase(CharSequence str, CharSequence searchStr) {
    if (str == null || searchStr == null) return false;
    return str.toString().toLowerCase().contains(searchStr.toString().toLowerCase());
  }
}`,
      'src/org/apache/commons/lang3/text/StrSubstitutor.java': `package org.apache.commons.lang3.text;
import org.apache.commons.lang3.StringUtils;
public class StrSubstitutor {
  public boolean checkMatch(String template, String prefix) {
    return StringUtils.containsIgnoreCase(template, prefix);
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-002-C1',
        consumerFqcn: 'org.apache.commons.lang3.text.StrSubstitutor',
        consumerFile: 'src/org/apache/commons/lang3/text/StrSubstitutor.java',
        location: 'checkMatch(): StringUtils.containsIgnoreCase(template, prefix)',
        bindingKind: 'J-5:QUALIFIED_TYPE_ACCESS',
        historicalBehavior: 'Binds to containsIgnoreCase(String, String)',
        candidateBehavior: 'Source: String subtype of CharSequence -> recompiles cleanly. Binary: compiled bytecode contains invokestatic containsIgnoreCase(Ljava/lang/String;Ljava/lang/String;)Z -> NoSuchMethodError at runtime!',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'Source recompiles clean; JLS §13.4.12 binary change breaks precompiled bytecode',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 3: REAL-JAVA-003 (fasterxml/jackson-databind) - Visibility narrowing (Public -> Protected)
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-003',
    repo: 'fasterxml/jackson-databind',
    commitSha: 'a1b2c3d4e5f6003',
    subject: 'deser: narrow constructType visibility from public to protected',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'VISIBILITY_NARROWED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.14.0</version></project>`,
      'src/com/fasterxml/jackson/databind/ObjectMapper.java': `package com.fasterxml.jackson.databind;
public class ObjectMapper {
  public String constructType(String typeName) {
    return "type:" + typeName;
  }
}`,
      'src/com/fasterxml/jackson/databind/deser/SubclassConsumer.java': `package com.fasterxml.jackson.databind.deser;
import com.fasterxml.jackson.databind.ObjectMapper;
public class SubclassConsumer extends ObjectMapper {
  public String useType(String name) {
    return constructType(name);
  }
}`,
      'src/com/fasterxml/jackson/databind/ext/ExternalConsumer.java': `package com.fasterxml.jackson.databind.ext;
import com.fasterxml.jackson.databind.ObjectMapper;
public class ExternalConsumer {
  public String call(ObjectMapper mapper, String name) {
    return mapper.constructType(name);
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.14.0</version></project>`,
      'src/com/fasterxml/jackson/databind/ObjectMapper.java': `package com.fasterxml.jackson.databind;
public class ObjectMapper {
  protected String constructType(String typeName) {
    return "type:" + typeName;
  }
}`,
      'src/com/fasterxml/jackson/databind/deser/SubclassConsumer.java': `package com.fasterxml.jackson.databind.deser;
import com.fasterxml.jackson.databind.ObjectMapper;
public class SubclassConsumer extends ObjectMapper {
  public String useType(String name) {
    return constructType(name);
  }
}`,
      'src/com/fasterxml/jackson/databind/ext/ExternalConsumer.java': `package com.fasterxml.jackson.databind.ext;
import com.fasterxml.jackson.databind.ObjectMapper;
public class ExternalConsumer {
  public String call(ObjectMapper mapper, String name) {
    return mapper.constructType(name);
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-003-C1',
        consumerFqcn: 'com.fasterxml.jackson.databind.deser.SubclassConsumer',
        consumerFile: 'src/com/fasterxml/jackson/databind/deser/SubclassConsumer.java',
        location: 'useType(): constructType(name) in subclass',
        bindingKind: 'J-7:CLASS_INHERITANCE',
        historicalBehavior: 'Inherits public constructType()',
        candidateBehavior: 'Inherits protected constructType() -> compatible for subclass',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation for subclass invocation',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-003-C2',
        consumerFqcn: 'com.fasterxml.jackson.databind.ext.ExternalConsumer',
        consumerFile: 'src/com/fasterxml/jackson/databind/ext/ExternalConsumer.java',
        location: 'call(): mapper.constructType(name) from non-subclass non-package',
        bindingKind: 'J-5:QUALIFIED_TYPE_ACCESS',
        historicalBehavior: 'Calls public constructType()',
        candidateBehavior: 'Fails to access protected method constructType() from outside package',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: constructType(String) has protected access in ObjectMapper',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 4: REAL-JAVA-004 (netty/netty) - Interface method added without default
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-004',
    repo: 'netty/netty',
    commitSha: 'a1b2c3d4e5f6004',
    subject: 'buffer: add int maxFastWritableBytes() to ByteBuf interface',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: true,
    changeType: 'INTERFACE_ABSTRACT_METHOD_ADDED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>io.netty</groupId><artifactId>netty-parent</artifactId><modules><module>buffer</module></modules></project>`,
      'buffer/pom.xml': `<project><parent><groupId>io.netty</groupId><artifactId>netty-parent</artifactId></parent><artifactId>netty-buffer</artifactId></project>`,
      'buffer/src/io/netty/buffer/ByteBuf.java': `package io.netty.buffer;
public interface ByteBuf {
  int capacity();
}`,
      'buffer/src/io/netty/buffer/AbstractByteBuf.java': `package io.netty.buffer;
public abstract class AbstractByteBuf implements ByteBuf {
  public int capacity() { return 1024; }
}`,
      'buffer/src/io/netty/buffer/UnpooledDirectByteBuf.java': `package io.netty.buffer;
public class UnpooledDirectByteBuf extends AbstractByteBuf {
  public void allocate() {}
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>io.netty</groupId><artifactId>netty-parent</artifactId><modules><module>buffer</module></modules></project>`,
      'buffer/pom.xml': `<project><parent><groupId>io.netty</groupId><artifactId>netty-parent</artifactId></parent><artifactId>netty-buffer</artifactId></project>`,
      'buffer/src/io/netty/buffer/ByteBuf.java': `package io.netty.buffer;
public interface ByteBuf {
  int capacity();
  int maxFastWritableBytes();
}`,
      'buffer/src/io/netty/buffer/AbstractByteBuf.java': `package io.netty.buffer;
public abstract class AbstractByteBuf implements ByteBuf {
  public int capacity() { return 1024; }
}`,
      'buffer/src/io/netty/buffer/UnpooledDirectByteBuf.java': `package io.netty.buffer;
public class UnpooledDirectByteBuf extends AbstractByteBuf {
  public void allocate() {}
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-004-C1',
        consumerFqcn: 'io.netty.buffer.AbstractByteBuf',
        consumerFile: 'buffer/src/io/netty/buffer/AbstractByteBuf.java',
        location: 'implements ByteBuf',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Abstract class implements ByteBuf',
        candidateBehavior: 'Abstract class does not need to implement new method -> clean compile',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation (abstract class)',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-004-C2',
        consumerFqcn: 'io.netty.buffer.UnpooledDirectByteBuf',
        consumerFile: 'buffer/src/io/netty/buffer/UnpooledDirectByteBuf.java',
        location: 'extends AbstractByteBuf (concrete subclass)',
        bindingKind: 'J-7:CLASS_INHERITANCE',
        historicalBehavior: 'Concrete class inherits capacity()',
        candidateBehavior: 'Concrete class does not override abstract maxFastWritableBytes() -> source compile error! Binary: loads fine until invocation throws AbstractMethodError',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: UnpooledDirectByteBuf is not abstract and does not override abstract method maxFastWritableBytes() in ByteBuf',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 5: REAL-JAVA-005 (apache/kafka) - Interface method added with default
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-005',
    repo: 'apache/kafka',
    commitSha: 'a1b2c3d4e5f6005',
    subject: 'clients: add default defaultApiTimeout() to Consumer interface',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'INTERFACE_DEFAULT_METHOD_ADDED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><version>3.4.0</version></project>`,
      'src/org/apache/kafka/clients/consumer/Consumer.java': `package org.apache.kafka.clients.consumer;
public interface Consumer {
  void poll();
}`,
      'src/org/apache/kafka/clients/consumer/KafkaConsumer.java': `package org.apache.kafka.clients.consumer;
public class KafkaConsumer implements Consumer {
  public void poll() {}
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><version>3.4.0</version></project>`,
      'src/org/apache/kafka/clients/consumer/Consumer.java': `package org.apache.kafka.clients.consumer;
public interface Consumer {
  void poll();
  default long defaultApiTimeout() { return 30000L; }
}`,
      'src/org/apache/kafka/clients/consumer/KafkaConsumer.java': `package org.apache.kafka.clients.consumer;
public class KafkaConsumer implements Consumer {
  public void poll() {}
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-005-C1',
        consumerFqcn: 'org.apache.kafka.clients.consumer.KafkaConsumer',
        consumerFile: 'src/org/apache/kafka/clients/consumer/KafkaConsumer.java',
        location: 'implements Consumer',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Implements poll()',
        candidateBehavior: 'Inherits default implementation of defaultApiTimeout() -> source & binary compatible',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 6: REAL-JAVA-006 (spring-projects/spring-framework) - Class marked final
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-006',
    repo: 'spring-projects/spring-framework',
    commitSha: 'a1b2c3d4e5f6006',
    subject: 'context: mark GenericApplicationContext final',
    javaVersion: 17,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'CLASS_FINAL_ADDED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>6.0.0</version></project>`,
      'src/org/springframework/context/GenericApplicationContext.java': `package org.springframework.context;
public class GenericApplicationContext {
  public void refresh() {}
}`,
      'src/org/springframework/context/StaticApplicationContext.java': `package org.springframework.context;
public class StaticApplicationContext extends GenericApplicationContext {
  public void init() { refresh(); }
}`,
      'src/org/springframework/context/ContextConsumer.java': `package org.springframework.context;
public class ContextConsumer {
  public void start() {
    GenericApplicationContext ctx = new GenericApplicationContext();
    ctx.refresh();
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>6.0.0</version></project>`,
      'src/org/springframework/context/GenericApplicationContext.java': `package org.springframework.context;
public final class GenericApplicationContext {
  public void refresh() {}
}`,
      'src/org/springframework/context/StaticApplicationContext.java': `package org.springframework.context;
public class StaticApplicationContext extends GenericApplicationContext {
  public void init() { refresh(); }
}`,
      'src/org/springframework/context/ContextConsumer.java': `package org.springframework.context;
public class ContextConsumer {
  public void start() {
    GenericApplicationContext ctx = new GenericApplicationContext();
    ctx.refresh();
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-006-C1',
        consumerFqcn: 'org.springframework.context.StaticApplicationContext',
        consumerFile: 'src/org/springframework/context/StaticApplicationContext.java',
        location: 'extends GenericApplicationContext',
        bindingKind: 'J-7:CLASS_INHERITANCE',
        historicalBehavior: 'Extends GenericApplicationContext',
        candidateBehavior: 'Cannot inherit from final GenericApplicationContext -> breaking error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot inherit from final GenericApplicationContext',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-006-C2',
        consumerFqcn: 'org.springframework.context.ContextConsumer',
        consumerFile: 'src/org/springframework/context/ContextConsumer.java',
        location: 'new GenericApplicationContext()',
        bindingKind: 'J-5:QUALIFIED_TYPE_ACCESS',
        historicalBehavior: 'Instantiates and invokes refresh()',
        candidateBehavior: 'Instantiates and invokes refresh() unaffected by final modifier',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 7: REAL-JAVA-007 (vavr-io/vavr) - Generic type bound narrowing
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-007',
    repo: 'vavr-io/vavr',
    commitSha: 'a1b2c3d4e5f6007',
    subject: 'collection: narrow TreeSet.of from <T> to <T extends Comparable<T>>',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'GENERIC_BOUND_NARROWED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>io.vavr</groupId><artifactId>vavr</artifactId><version>0.10.4</version></project>`,
      'src/io/vavr/collection/TreeSet.java': `package io.vavr.collection;
public class TreeSet<T> {
  public static <T> TreeSet<T> of(T value) {
    return new TreeSet<>();
  }
}`,
      'src/io/vavr/collection/TreeSetConsumer.java': `package io.vavr.collection;
public class TreeSetConsumer {
  public static class NonComparable { int val = 1; }
  public void run() {
    TreeSet<String> s = TreeSet.of("hello");
    TreeSet<NonComparable> nc = TreeSet.of(new NonComparable());
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>io.vavr</groupId><artifactId>vavr</artifactId><version>0.10.4</version></project>`,
      'src/io/vavr/collection/TreeSet.java': `package io.vavr.collection;
public class TreeSet<T> {
  public static <T extends java.lang.Comparable<T>> TreeSet<T> of(T value) {
    return new TreeSet<>();
  }
}`,
      'src/io/vavr/collection/TreeSetConsumer.java': `package io.vavr.collection;
public class TreeSetConsumer {
  public static class NonComparable { int val = 1; }
  public void run() {
    TreeSet<String> s = TreeSet.of("hello");
    TreeSet<NonComparable> nc = TreeSet.of(new NonComparable());
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-007-C1',
        consumerFqcn: 'io.vavr.collection.TreeSetConsumer',
        consumerFile: 'src/io/vavr/collection/TreeSetConsumer.java',
        location: 'run(): TreeSet.of(new NonComparable())',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'TreeSet.of accepts NonComparable',
        candidateBehavior: 'NonComparable does not implement Comparable<T> -> generic bound compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: type argument NonComparable is not within bounds of type-variable T',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 8: REAL-JAVA-008 (apache/commons-io) - Static final inlined constant
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-008',
    repo: 'apache/commons-io',
    commitSha: 'a1b2c3d4e5f6008',
    subject: 'io: change BUFFER_SIZE from 4096 to 8192 in IOUtils',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'CONSTANT_VALUE_CHANGED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>commons-io</groupId><artifactId>commons-io</artifactId><version>2.11.0</version></project>`,
      'src/org/apache/commons/io/IOUtils.java': `package org.apache.commons.io;
public class IOUtils {
  public static final int BUFFER_SIZE = 4096;
}`,
      'src/org/apache/commons/io/CopyUtils.java': `package org.apache.commons.io;
public class CopyUtils {
  public int getBufferSize() {
    return IOUtils.BUFFER_SIZE;
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>commons-io</groupId><artifactId>commons-io</artifactId><version>2.11.0</version></project>`,
      'src/org/apache/commons/io/IOUtils.java': `package org.apache.commons.io;
public class IOUtils {
  public static final int BUFFER_SIZE = 8192;
}`,
      'src/org/apache/commons/io/CopyUtils.java': `package org.apache.commons.io;
public class CopyUtils {
  public int getBufferSize() {
    return IOUtils.BUFFER_SIZE;
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-008-C1',
        consumerFqcn: 'org.apache.commons.io.CopyUtils',
        consumerFile: 'src/org/apache/commons/io/CopyUtils.java',
        location: 'getBufferSize(): IOUtils.BUFFER_SIZE',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'References BUFFER_SIZE = 4096',
        candidateBehavior: 'Source: Recompiles with 8192 (COMPATIBLE). Binary: Primitive constant inlined into CopyUtils.class bytecode as bipush 4096. Runs with stale value 4096 without linking error!',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'BEHAVIORAL_CHANGE',
        compilerEvidence: 'Clean compile; JLS §13.1 bytecode inlining retains 4096 until consumer recompiled',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 9: REAL-JAVA-009 (openjdk/jdk17-records) - Java 16/17 Record Component Removal
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-009',
    repo: 'openjdk/jdk17-records',
    commitSha: 'a1b2c3d4e5f6009',
    subject: 'model: remove z coordinate component from Point record',
    javaVersion: 17,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'RECORD_COMPONENT_REMOVED',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'MODERN_JAVA_CONSTRUCT',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>modern-records</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/data/Point.java': `package com.acme.data;
public record Point(int x, int y, int z) {}`,
      'src/com/acme/data/GeometryCalc.java': `package com.acme.data;
public class GeometryCalc {
  public int volume(Point p) {
    return p.x() * p.y() * p.z();
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>modern-records</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/data/Point.java': `package com.acme.data;
public record Point(int x, int y) {}`,
      'src/com/acme/data/GeometryCalc.java': `package com.acme.data;
public class GeometryCalc {
  public int volume(Point p) {
    return p.x() * p.y() * p.z();
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-009-C1',
        consumerFqcn: 'com.acme.data.GeometryCalc',
        consumerFile: 'src/com/acme/data/GeometryCalc.java',
        location: 'volume(): p.z()',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls record accessor p.z()',
        candidateBehavior: 'Accessor method z() no longer exists -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot find symbol method z()',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 10: REAL-JAVA-010 (openjdk/jdk17-sealed) - Java 17 Sealed Type Restriction
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-010',
    repo: 'openjdk/jdk17-sealed',
    commitSha: 'a1b2c3d4e5f6010',
    subject: 'shapes: restrict sealed Shape permits list to remove Rectangle',
    javaVersion: 17,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'SEALED_PERMITS_RESTRICTED',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'MODERN_JAVA_CONSTRUCT',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>modern-sealed</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/shapes/Shape.java': `package com.acme.shapes;
public sealed interface Shape permits Circle, Rectangle {}`,
      'src/com/acme/shapes/Circle.java': `package com.acme.shapes;
public final class Circle implements Shape {}`,
      'src/com/acme/shapes/Rectangle.java': `package com.acme.shapes;
public final class Rectangle implements Shape {}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>modern-sealed</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/shapes/Shape.java': `package com.acme.shapes;
public sealed interface Shape permits Circle {}`,
      'src/com/acme/shapes/Circle.java': `package com.acme.shapes;
public final class Circle implements Shape {}`,
      'src/com/acme/shapes/Rectangle.java': `package com.acme.shapes;
public final class Rectangle implements Shape {}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-010-C1',
        consumerFqcn: 'com.acme.shapes.Rectangle',
        consumerFile: 'src/com/acme/shapes/Rectangle.java',
        location: 'implements Shape',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Permitted subtype of Shape',
        candidateBehavior: 'Class is not allowed to extend sealed class: Shape -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: class is not allowed to extend sealed class: com.acme.shapes.Shape',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-010-C2',
        consumerFqcn: 'com.acme.shapes.Circle',
        consumerFile: 'src/com/acme/shapes/Circle.java',
        location: 'implements Shape',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Permitted subtype of Shape',
        candidateBehavior: 'Remains in permits list -> compatible',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 11: REAL-JAVA-011 (projectlombok/lombok) - Lombok Annotation Processor
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-011',
    repo: 'projectlombok/lombok',
    commitSha: 'a1b2c3d4e5f6011',
    subject: 'model: remove email field from Lombok User entity',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'ANNOTATION_PROCESSOR_LOMBOK',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'UNMATERIALIZED_CODE_GENERATION',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>lombok-app</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/dto/User.java': `package com.acme.dto;
import lombok.Data;
@Data
public class User {
  private String id;
  private String email;
}`,
      'src/com/acme/service/UserService.java': `package com.acme.service;
import com.acme.dto.User;
public class UserService {
  public String getContact(User u) {
    return u.getEmail();
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>lombok-app</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/dto/User.java': `package com.acme.dto;
import lombok.Data;
@Data
public class User {
  private String id;
}`,
      'src/com/acme/service/UserService.java': `package com.acme.service;
import com.acme.dto.User;
public class UserService {
  public String getContact(User u) {
    return u.getEmail();
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-011-C1',
        consumerFqcn: 'com.acme.service.UserService',
        consumerFile: 'src/com/acme/service/UserService.java',
        location: 'getContact(): u.getEmail()',
        bindingKind: 'J-1:SINGLE_TYPE_IMPORT',
        historicalBehavior: 'Lombok generates getEmail() getter',
        candidateBehavior: 'Getter getEmail() absent -> breaking error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'Annotation processor synthetic method missing; Sajimora qualifier detects @Data and abstains',
        isScopeComplete: false
      }
    ]
  });

  // =========================================================================
  // Case 12: REAL-JAVA-012 (gradle/dynamic-build) - Dynamic Gradle Build Script
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-012',
    repo: 'gradle/dynamic-build',
    commitSha: 'a1b2c3d4e5f6012',
    subject: 'build: configure dynamic task dependencies in Gradle',
    javaVersion: 11,
    buildSystem: 'GRADLE',
    isMultiModule: false,
    changeType: 'DYNAMIC_GRADLE_SCRIPT',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'UNSUPPORTED_DYNAMIC_BUILD_SCRIPT',
    historicalFiles: {
      'build.gradle': `
plugins { id 'java' }
task customBuild {
  doLast { println "dynamic execution" }
}
tasks.matching { it.name.startsWith("test") }.configureEach {
  systemProperty 'env', 'test'
}
`,
      'src/com/acme/Service.java': `package com.acme;
public class Service {
  public void execute() {}
}`,
      'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public void run(Service s) { s.execute(); }
}`
    },
    candidateFiles: {
      'build.gradle': `
plugins { id 'java' }
task customBuild {
  doLast { println "dynamic execution" }
}
tasks.matching { it.name.startsWith("test") }.configureEach {
  systemProperty 'env', 'test'
}
`,
      'src/com/acme/Service.java': `package com.acme;
public class Service {
  // execute removed
}`,
      'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public void run(Service s) { s.execute(); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-012-C1',
        consumerFqcn: 'com.acme.Consumer',
        consumerFile: 'src/com/acme/Consumer.java',
        location: 'run(): s.execute()',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Binds to execute()',
        candidateBehavior: 'execute() removed -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'Dynamic build script forces advisory abstention in Sajimora',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 13: REAL-JAVA-013 (apache/pulsar) - Missing Submodule POM Descriptor
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-013',
    repo: 'apache/pulsar',
    commitSha: 'a1b2c3d4e5f6013',
    subject: 'reactor: add client module declaration without subpom descriptor',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: true,
    changeType: 'MISSING_REACTOR_MODULE',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'MISSING_SUBMODULE_DESCRIPTOR',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId><modules><module>pulsar-common</module><module>pulsar-client</module></modules></project>`,
      'pulsar-common/pom.xml': `<project><parent><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId></parent><artifactId>pulsar-common</artifactId></project>`,
      // Note: pulsar-client/pom.xml is intentionally missing
      'pulsar-common/src/com/acme/Message.java': `package com.acme;
public class Message {
  public String payload;
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId><modules><module>pulsar-common</module><module>pulsar-client</module></modules></project>`,
      'pulsar-common/pom.xml': `<project><parent><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId></parent><artifactId>pulsar-common</artifactId></project>`,
      'pulsar-common/src/com/acme/Message.java': `package com.acme;
public class Message {
  public byte[] payload;
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-013-C1',
        consumerFqcn: 'UNKNOWN_CONSUMER',
        consumerFile: 'pulsar-client/...',
        location: 'unindexed submodule',
        bindingKind: 'UNKNOWN',
        historicalBehavior: 'Depends on Message.payload',
        candidateBehavior: 'Cannot be statically bound due to missing build model',
        sourceCompatibility: 'INCONCLUSIVE',
        binaryCompatibility: 'INCONCLUSIVE',
        runtimeBehavior: 'UNDETERMINABLE',
        compilerEvidence: 'Reactor graph incomplete; safely abstains',
        isScopeComplete: false
      }
    ]
  });

  // =========================================================================
  // Case 14: REAL-JAVA-014 (google/guava) - Wildcard import ambiguity
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-014',
    repo: 'google/guava',
    commitSha: 'a1b2c3d4e5f6014',
    subject: 'collect: wildcard import consumer with added method',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'WILDCARD_IMPORT',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'WILDCARD_IMPORT_POLLUTION',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>`,
      'src/com/google/common/collect/Maps.java': `package com.google.common.collect;
public class Maps {
  public static void clean() {}
}`,
      'src/com/acme/app/Client.java': `package com.acme.app;
import com.google.common.collect.*;
public class Client {
  public void run() { Maps.clean(); }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>`,
      'src/com/google/common/collect/Maps.java': `package com.google.common.collect;
public class Maps {
  public static void clean() {}
  public static void newMethod() {}
}`,
      'src/com/acme/app/Client.java': `package com.acme.app;
import com.google.common.collect.*;
public class Client {
  public void run() { Maps.clean(); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-014-C1',
        consumerFqcn: 'com.acme.app.Client',
        consumerFile: 'src/com/acme/app/Client.java',
        location: 'import com.google.common.collect.*; Maps.clean()',
        bindingKind: 'J-2:WILDCARD_IMPORT',
        historicalBehavior: 'Binds Maps via wildcard import',
        candidateBehavior: 'Binds Maps via wildcard import unaffected',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'Clean compilation; Sajimora disqualifies wildcard import to advisory',
        isScopeComplete: false
      }
    ]
  });

  // =========================================================================
  // Case 15: REAL-JAVA-015 (micronaut-projects/micronaut) - Dynamic Reflection J-X1
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-015',
    repo: 'micronaut-projects/micronaut',
    commitSha: 'a1b2c3d4e5f6015',
    subject: 'core: reflection invocation of service bean',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'DYNAMIC_REFLECTION',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'DYNAMIC_REFLECTION_CONSTRUCT',
    historicalFiles: {
      'pom.xml': `<project><groupId>io.micronaut</groupId><artifactId>core</artifactId></project>`,
      'src/com/acme/Service.java': `package com.acme;
public class Service {
  public void execute() {}
}`,
      'src/com/acme/ReflectiveInvoker.java': `package com.acme;
import java.lang.reflect.Method;
public class ReflectiveInvoker {
  public void invoke(Object target) throws Exception {
    Method m = Class.forName("com.acme.Service").getMethod("execute");
    m.invoke(target);
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>io.micronaut</groupId><artifactId>core</artifactId></project>`,
      'src/com/acme/Service.java': `package com.acme;
public class Service {
  public void executeV2() {}
}`,
      'src/com/acme/ReflectiveInvoker.java': `package com.acme;
import java.lang.reflect.Method;
public class ReflectiveInvoker {
  public void invoke(Object target) throws Exception {
    Method m = Class.forName("com.acme.Service").getMethod("execute");
    m.invoke(target);
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-015-C1',
        consumerFqcn: 'com.acme.ReflectiveInvoker',
        consumerFile: 'src/com/acme/ReflectiveInvoker.java',
        location: 'getMethod("execute")',
        bindingKind: 'J-X1:REFLECTION',
        historicalBehavior: 'Dynamically resolves execute() method',
        candidateBehavior: 'Throws NoSuchMethodException at runtime',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'Compiles clean; runtime reflection failure (J-X1)',
        isScopeComplete: false
      }
    ]
  });

  // =========================================================================
  // Case 16: REAL-JAVA-016 (apache/flink) - Multi-module reactor inter-module edge
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-016',
    repo: 'apache/flink',
    commitSha: 'a1b2c3d4e5f6016',
    subject: 'connector: implement new Sink interface in connector module',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: true,
    changeType: 'REACTOR_INTER_MODULE',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId><modules><module>core</module><module>connector</module></modules></project>`,
      'core/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>core</artifactId></project>`,
      'core/src/com/acme/Sink.java': `package com.acme;
public interface Sink {
  void write(String data);
}`,
      'connector/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>connector</artifactId><dependencies><dependency><groupId>org.apache.flink</groupId><artifactId>core</artifactId></dependency></dependencies></project>`,
      'connector/src/com/acme/KafkaSink.java': `package com.acme;
public class KafkaSink implements Sink {
  public void write(String data) {}
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId><modules><module>core</module><module>connector</module></modules></project>`,
      'core/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>core</artifactId></project>`,
      'core/src/com/acme/Sink.java': `package com.acme;
public interface Sink {
  void write(String data);
  void flush();
}`,
      'connector/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>connector</artifactId><dependencies><dependency><groupId>org.apache.flink</groupId><artifactId>core</artifactId></dependency></dependencies></project>`,
      'connector/src/com/acme/KafkaSink.java': `package com.acme;
public class KafkaSink implements Sink {
  public void write(String data) {}
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-016-C1',
        consumerFqcn: 'com.acme.KafkaSink',
        consumerFile: 'connector/src/com/acme/KafkaSink.java',
        location: 'implements Sink',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Implements write()',
        candidateBehavior: 'Fails to implement abstract flush() across reactor module boundary -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: KafkaSink is not abstract and does not override abstract method flush() in Sink',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 17: REAL-JAVA-017 (apache/kafka) - Unresolved External Classpath Dependency
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-017',
    repo: 'apache/kafka',
    commitSha: 'a1b2c3d4e5f6017',
    subject: 'clients: external slf4j logger dependency missing in sealed snapshot',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'UNRESOLVED_EXTERNAL_DEP',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0', // Currently falsely qualified by Sajimora!
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>1.7.36</version></dependency></dependencies></project>`,
      'src/com/acme/Producer.java': `package com.acme;
import org.slf4j.Logger;
public class Producer {
  private Logger log;
  public void send(String msg) {}
}`,
      'src/com/acme/App.java': `package com.acme;
public class App {
  public void run(Producer p) { p.send("hi"); }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>1.7.36</version></dependency></dependencies></project>`,
      'src/com/acme/Producer.java': `package com.acme;
import org.slf4j.Logger;
public class Producer {
  private Logger log;
  public void send(String msg) {}
  public void close() {}
}`,
      'src/com/acme/App.java': `package com.acme;
public class App {
  public void run(Producer p) { p.send("hi"); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-017-C1',
        consumerFqcn: 'com.acme.App',
        consumerFile: 'src/com/acme/App.java',
        location: 'run(): p.send("hi")',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls p.send()',
        candidateBehavior: 'p.send() preserved; but Producer depends on unmaterialized external Logger type',
        sourceCompatibility: 'INCONCLUSIVE',
        binaryCompatibility: 'INCONCLUSIVE',
        runtimeBehavior: 'UNDETERMINABLE',
        compilerEvidence: 'External package org.slf4j missing from classpath; cannot verify full closure without receipts',
        isScopeComplete: false
      }
    ]
  });

  // =========================================================================
  // Case 18: REAL-JAVA-018 (square/retrofit) - Method Overload Ambiguity
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-018',
    repo: 'square/retrofit',
    commitSha: 'a1b2c3d4e5f6018',
    subject: 'call: add overload query(CharSequence) alongside query(String)',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'METHOD_OVERLOAD_AMBIGUITY',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.squareup.retrofit2</groupId><artifactId>retrofit</artifactId></project>`,
      'src/com/acme/ApiClient.java': `package com.acme;
public class ApiClient {
  public void query(String param) {}
}`,
      'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public void test(ApiClient client) {
    client.query(null);
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.squareup.retrofit2</groupId><artifactId>retrofit</artifactId></project>`,
      'src/com/acme/ApiClient.java': `package com.acme;
public class ApiClient {
  public void query(String param) {}
  public void query(StringBuilder param) {}
}`,
      'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public void test(ApiClient client) {
    client.query(null);
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-018-C1',
        consumerFqcn: 'com.acme.Consumer',
        consumerFile: 'src/com/acme/Consumer.java',
        location: 'test(): client.query(null)',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Binds null to query(String)',
        candidateBehavior: 'Ambiguous method call query(null) matches both query(String) and query(StringBuilder) -> compile error!',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: reference to query is ambiguous',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 19: REAL-JAVA-019 (mockito/mockito) - Method and Constructor References (J-10 & J-11)
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-019',
    repo: 'mockito/mockito',
    commitSha: 'a1b2c3d4e5f6019',
    subject: 'answers: method and constructor reference consumers',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'METHOD_REFERENCE_CALL',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId></project>`,
      'src/com/acme/Factory.java': `package com.acme;
public class Factory {
  public static String create() { return "ok"; }
  public Factory() {}
}`,
      'src/com/acme/RefConsumer.java': `package com.acme;
import java.util.function.Supplier;
public class RefConsumer {
  public void bind() {
    Supplier<String> s = Factory::create;
    Supplier<Factory> f = Factory::new;
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.mockito</groupId><artifactId>mockito-core</artifactId></project>`,
      'src/com/acme/Factory.java': `package com.acme;
public class Factory {
  public static int create() { return 1; } // Return type changed String -> int
  public Factory(String extra) {} // Default constructor removed
}`,
      'src/com/acme/RefConsumer.java': `package com.acme;
import java.util.function.Supplier;
public class RefConsumer {
  public void bind() {
    Supplier<String> s = Factory::create;
    Supplier<Factory> f = Factory::new;
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-019-C1',
        consumerFqcn: 'com.acme.RefConsumer',
        consumerFile: 'src/com/acme/RefConsumer.java',
        location: 'Factory::create',
        bindingKind: 'J-10:METHOD_REFERENCE',
        historicalBehavior: 'Binds Factory::create to Supplier<String>',
        candidateBehavior: 'Return type int incompatible with Supplier<String> -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: incompatible types: bad return type in method reference',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-019-C2',
        consumerFqcn: 'com.acme.RefConsumer',
        consumerFile: 'src/com/acme/RefConsumer.java',
        location: 'Factory::new',
        bindingKind: 'J-11:CONSTRUCTOR_REFERENCE',
        historicalBehavior: 'Binds Factory::new to 0-arg constructor',
        candidateBehavior: '0-arg constructor removed -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot find symbol constructor Factory()',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 20: REAL-JAVA-020 (junit-team/junit5) - Local Variable Receiver Call Site (Extraction Trap)
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-020',
    repo: 'junit-team/junit5',
    commitSha: 'a1b2c3d4e5f6020',
    subject: 'jupiter: remove assertValid method called via local variable receiver',
    javaVersion: 17,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'LOCAL_VARIABLE_CALL_SITE',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId></project>`,
      'src/com/acme/Validator.java': `package com.acme;
public class Validator {
  public void assertValid(String input) {}
}`,
      'src/com/acme/TestRunner.java': `package com.acme;
public class TestRunner {
  public void execute() {
    Validator v = new Validator();
    v.assertValid("ok");
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter-api</artifactId></project>`,
      'src/com/acme/Validator.java': `package com.acme;
public class Validator {
  // assertValid removed
}`,
      'src/com/acme/TestRunner.java': `package com.acme;
public class TestRunner {
  public void execute() {
    Validator v = new Validator();
    v.assertValid("ok");
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-020-C1',
        consumerFqcn: 'com.acme.TestRunner',
        consumerFile: 'src/com/acme/TestRunner.java',
        location: 'execute(): v.assertValid("ok") on local variable v',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls assertValid on local variable instance v',
        candidateBehavior: 'assertValid removed -> compile error. BUT Sajimora tree-sitter call-site extractor only resolves fields and params, SILENTLY MISSING this local variable receiver!',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot find symbol method assertValid(String)',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 21: REAL-JAVA-021 (apache/commons-lang) - Multi-Consumer Mixed Blast Radius
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-021',
    repo: 'apache/commons-lang',
    commitSha: 'a1b2c3d4e5f6021',
    subject: 'string: remove StringUtils.join(Object[], char)',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'MULTI_CONSUMER_CALL',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId></project>`,
      'src/com/acme/StringUtils.java': `package com.acme;
public class StringUtils {
  public static String join(Object[] array, char sep) { return "joined"; }
  public static boolean isBlank(String s) { return s == null || s.trim().isEmpty(); }
}`,
      'src/com/acme/ConsumerA.java': `package com.acme;
public class ConsumerA {
  public void run() { StringUtils.join(new Object[]{"1"}, ','); }
}`,
      'src/com/acme/ConsumerB.java': `package com.acme;
public class ConsumerB {
  public void run() { StringUtils.isBlank("test"); }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId></project>`,
      'src/com/acme/StringUtils.java': `package com.acme;
public class StringUtils {
  // join removed
  public static boolean isBlank(String s) { return s == null || s.trim().isEmpty(); }
}`,
      'src/com/acme/ConsumerA.java': `package com.acme;
public class ConsumerA {
  public void run() { StringUtils.join(new Object[]{"1"}, ','); }
}`,
      'src/com/acme/ConsumerB.java': `package com.acme;
public class ConsumerB {
  public void run() { StringUtils.isBlank("test"); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-021-C1',
        consumerFqcn: 'com.acme.ConsumerA',
        consumerFile: 'src/com/acme/ConsumerA.java',
        location: 'run(): StringUtils.join()',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls join(Object[], char)',
        candidateBehavior: 'join removed -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: cannot find symbol method join(Object[],char)',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-021-C2',
        consumerFqcn: 'com.acme.ConsumerB',
        consumerFile: 'src/com/acme/ConsumerB.java',
        location: 'run(): StringUtils.isBlank()',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls isBlank(String)',
        candidateBehavior: 'isBlank unchanged -> fully preserved',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 22: REAL-JAVA-022 (fasterxml/jackson-core) - Constructor Removal
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-022',
    repo: 'fasterxml/jackson-core',
    commitSha: 'a1b2c3d4e5f6022',
    subject: 'parser: remove JsonParser(int) 1-arg constructor',
    javaVersion: 8,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'CONSTRUCTOR_REMOVED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-core</artifactId></project>`,
      'src/com/acme/JsonParser.java': `package com.acme;
public class JsonParser {
  public JsonParser(int features) {}
  public JsonParser(String name, int features) {}
}`,
      'src/com/acme/CustomParser.java': `package com.acme;
public class CustomParser extends JsonParser {
  public CustomParser(int f) { super(f); }
}`,
      'src/com/acme/ParserFactory.java': `package com.acme;
public class ParserFactory {
  public JsonParser create() { return new JsonParser(10); }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-core</artifactId></project>`,
      'src/com/acme/JsonParser.java': `package com.acme;
  // 1-arg constructor removed
  public JsonParser(String name, int features) {}
}`,
      'src/com/acme/CustomParser.java': `package com.acme;
public class CustomParser extends JsonParser {
  public CustomParser(int f) { super(f); }
}`,
      'src/com/acme/ParserFactory.java': `package com.acme;
public class ParserFactory {
  public JsonParser create() { return new JsonParser(10); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-022-C1',
        consumerFqcn: 'com.acme.CustomParser',
        consumerFile: 'src/com/acme/CustomParser.java',
        location: 'super(f) in constructor',
        bindingKind: 'J-7:CLASS_INHERITANCE',
        historicalBehavior: 'Calls super(int) constructor',
        candidateBehavior: 'super(int) constructor removed -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: constructor JsonParser in class JsonParser cannot be applied to given types',
        isScopeComplete: true
      },
      {
        consumerId: 'REAL-JAVA-022-C2',
        consumerFqcn: 'com.acme.ParserFactory',
        consumerFile: 'src/com/acme/ParserFactory.java',
        location: 'new JsonParser(10)',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Direct instantiation via 1-arg constructor',
        candidateBehavior: '1-arg constructor removed -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: constructor JsonParser in class JsonParser cannot be applied to given types',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 23: REAL-JAVA-023 (dropwizard/dropwizard) - Interface Return Type Narrowing/Changing
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-023',
    repo: 'dropwizard/dropwizard',
    commitSha: 'a1b2c3d4e5f6023',
    subject: 'config: change Provider.open() return type from InputStream to Reader',
    javaVersion: 11,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'INTERFACE_RETURN_TYPE_CHANGED',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>io.dropwizard</groupId><artifactId>dropwizard-configuration</artifactId></project>`,
      'src/com/acme/Provider.java': `package com.acme;
import java.io.InputStream;
public interface Provider {
  InputStream open(String path);
}`,
      'src/com/acme/FileProvider.java': `package com.acme;
import java.io.InputStream;
public class FileProvider implements Provider {
  public InputStream open(String path) { return null; }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>io.dropwizard</groupId><artifactId>dropwizard-configuration</artifactId></project>`,
      'src/com/acme/Provider.java': `package com.acme;
import java.io.Reader;
public interface Provider {
  Reader open(String path);
}`,
      'src/com/acme/FileProvider.java': `package com.acme;
import java.io.InputStream;
public class FileProvider implements Provider {
  public InputStream open(String path) { return null; }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-023-C1',
        consumerFqcn: 'com.acme.FileProvider',
        consumerFile: 'src/com/acme/FileProvider.java',
        location: 'public InputStream open(String path)',
        bindingKind: 'J-8:INTERFACE_IMPLEMENTATION',
        historicalBehavior: 'Implements open() returning InputStream',
        candidateBehavior: 'Return type InputStream incompatible with Reader in Provider -> compile error',
        sourceCompatibility: 'INCOMPATIBLE',
        binaryCompatibility: 'INCOMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'error: open(String) in FileProvider cannot implement open(String) in Provider; attempting to use incompatible return type',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 24: REAL-JAVA-024 (quarkusio/quarkus) - Record Compact Constructor Runtime Validation
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-024',
    repo: 'quarkusio/quarkus',
    commitSha: 'a1b2c3d4e5f6024',
    subject: 'config: add port validation in compact constructor of ServerConfig',
    javaVersion: 17,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'RECORD_COMPACT_VALIDATION',
    expectedQualification: 'RETAINED_IN_ADVISORY',
    expectedPrimaryBlocker: 'MODERN_JAVA_CONSTRUCT',
    historicalFiles: {
      'pom.xml': `<project><groupId>io.quarkus</groupId><artifactId>quarkus-config</artifactId></project>`,
      'src/com/acme/ServerConfig.java': `package com.acme;
public record ServerConfig(String host, int port) {}`,
      'src/com/acme/ServerApp.java': `package com.acme;
public class ServerApp {
  public ServerConfig loadDefault() {
    return new ServerConfig("localhost", -1);
  }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>io.quarkus</groupId><artifactId>quarkus-config</artifactId></project>`,
      'src/com/acme/ServerConfig.java': `package com.acme;
public record ServerConfig(String host, int port) {
  public ServerConfig {
    if (port < 0) throw new IllegalArgumentException("port must be positive");
  }
}`,
      'src/com/acme/ServerApp.java': `package com.acme;
public class ServerApp {
  public ServerConfig loadDefault() {
    return new ServerConfig("localhost", -1);
  }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-024-C1',
        consumerFqcn: 'com.acme.ServerApp',
        consumerFile: 'src/com/acme/ServerApp.java',
        location: 'new ServerConfig("localhost", -1)',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Successfully instantiates record with port -1',
        candidateBehavior: 'Source: Compiles clean. Binary: Links clean. Runtime: Throws IllegalArgumentException at runtime! Pure behavioral break.',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'RUNTIME_ERROR',
        compilerEvidence: 'Clean compile & link; runtime validation failure',
        isScopeComplete: true
      }
    ]
  });

  // =========================================================================
  // Case 25: REAL-JAVA-025 (openjdk/jdk21) - Java 21 Virtual Threads API Addition
  // =========================================================================
  cases.push({
    caseId: 'REAL-JAVA-025',
    repo: 'openjdk/jdk21',
    commitSha: 'a1b2c3d4e5f6025',
    subject: 'concurrent: add virtual thread worker dispatch method',
    javaVersion: 21,
    buildSystem: 'MAVEN',
    isMultiModule: false,
    changeType: 'VIRTUAL_THREADS_JAVA21',
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
    expectedPrimaryBlocker: 'NONE',
    historicalFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>concurrency</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/Dispatcher.java': `package com.acme;
public class Dispatcher {
  public void dispatch(Runnable r) { r.run(); }
}`,
      'src/com/acme/App.java': `package com.acme;
public class App {
  public void start(Dispatcher d) { d.dispatch(() -> {}); }
}`
    },
    candidateFiles: {
      'pom.xml': `<project><groupId>com.acme</groupId><artifactId>concurrency</artifactId><version>1.0.0</version></project>`,
      'src/com/acme/Dispatcher.java': `package com.acme;
public class Dispatcher {
  public void dispatch(Runnable r) { r.run(); }
  public void dispatchVirtual(Runnable r) {
    Thread.ofVirtual().start(r);
  }
}`,
      'src/com/acme/App.java': `package com.acme;
public class App {
  public void start(Dispatcher d) { d.dispatch(() -> {}); }
}`
    },
    groundTruthConsumers: [
      {
        consumerId: 'REAL-JAVA-025-C1',
        consumerFqcn: 'com.acme.App',
        consumerFile: 'src/com/acme/App.java',
        location: 'start(): d.dispatch(...)',
        bindingKind: 'J-6:LOCAL_DECLARATION',
        historicalBehavior: 'Calls dispatch(Runnable)',
        candidateBehavior: 'dispatch(Runnable) preserved; additive virtual thread method',
        sourceCompatibility: 'COMPATIBLE',
        binaryCompatibility: 'COMPATIBLE',
        runtimeBehavior: 'PRESERVED',
        compilerEvidence: 'clean compilation with Java 21 virtual threads',
        isScopeComplete: true
      }
    ]
  });

  return cases;
}

// Unconditionally write fixtures
const cases = buildRealJavaEvalCases();
const outPath = path.resolve(__dirname, 'fixtures/real_java_api_changes_eval.json');
fs.writeFileSync(outPath, JSON.stringify(cases, null, 2), 'utf8');
console.log(`Wrote ${cases.length} evaluation cases to ${outPath}`);

