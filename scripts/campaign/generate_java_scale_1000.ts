/**
 * @file generate_java_scale_1000.ts
 * Generates 1,000 deterministic real-world styled Java benchmark cases
 * across Guava, Jackson, and Spring ecosystems for Phase J-10B.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
export interface JavaScaleCase {
  id: string;
  category: string;
  description: string;
  historicalFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  goldSet: {
    expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0' | 'RETAINED_IN_ADVISORY';
    expectedVerdict: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNCERTIFIED' | 'INCONCLUSIVE';
    goldConsumers?: string[];
    goldBreakingConsumers?: string[];
  };
}

export function generateJavaScale1000Cases(): JavaScaleCase[] {
  const cases: JavaScaleCase[] = [];

  // =========================================================================
  // FAMILY 1: GUAVA ECOSYSTEM (300 cases: guava-001 to guava-300)
  // Collections, Functional Primitives, Utilities, Reactor Graphs
  // =========================================================================
  for (let i = 1; i <= 300; i++) {
    const id = `guava-${String(i).padStart(3, '0')}`;
    const mod = i % 10;

    if (mod >= 0 && mod <= 3) {
      // Clean Compatible (120 cases): Add static method, overload, or helper
      cases.push({
        id,
        category: 'GUAVA_CLEAN_COMPATIBLE',
        description: `Guava Collections utility extension #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.0.0</version></project>',
          'src/com/google/common/collect/Iterables.java': `package com.google.common.collect;\npublic class Iterables {\n  public static int size(Iterable<?> it) { return 0; }\n}`,
          'src/com/google/common/collect/Consumer.java': `package com.google.common.collect;\nimport com.google.common.collect.Iterables;\npublic class Consumer {\n  public int count(Iterable<?> it) { return Iterables.size(it); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.0.0</version></project>',
          'src/com/google/common/collect/Iterables.java': `package com.google.common.collect;\npublic class Iterables {\n  public static int size(Iterable<?> it) { return 0; }\n  public static boolean isEmpty(Iterable<?> it) { return size(it) == 0; }\n}`,
          'src/com/google/common/collect/Consumer.java': `package com.google.common.collect;\nimport com.google.common.collect.Iterables;\npublic class Consumer {\n  public int count(Iterable<?> it) { return Iterables.size(it); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'COMPATIBLE',
          goldConsumers: ['src/com/google/common/collect/Consumer.java'],
          goldBreakingConsumers: []
        }
      });
    } else if (mod >= 4 && mod <= 6) {
      // Clean Breaking (90 cases): Method removal or signature breaking change
      const isRemoval = mod === 4;
      cases.push({
        id,
        category: 'GUAVA_CLEAN_BREAKING',
        description: isRemoval ? `Guava method removal #${i}` : `Guava parameter mutation #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.0.0</version></project>',
          'src/com/google/common/base/Preconditions.java': `package com.google.common.base;\npublic class Preconditions {\n  public static void checkArgument(boolean b${isRemoval ? '' : ', String msg'}) {}\n}`,
          'src/com/google/common/base/Client.java': `package com.google.common.base;\nimport com.google.common.base.Preconditions;\npublic class Client {\n  public void validate(boolean state) { Preconditions.checkArgument(state${isRemoval ? '' : ', "err"'}); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.0.0</version></project>',
          'src/com/google/common/base/Preconditions.java': `package com.google.common.base;\npublic class Preconditions {\n  ${isRemoval ? 'public static void other() {}' : 'public static void checkArgument(boolean b) {}'}\n}`,
          'src/com/google/common/base/Client.java': `package com.google.common.base;\nimport com.google.common.base.Preconditions;\npublic class Client {\n  public void validate(boolean state) { Preconditions.checkArgument(state${isRemoval ? '' : ', "err"'}); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'INCOMPATIBLE',
          goldConsumers: ['src/com/google/common/base/Client.java'],
          goldBreakingConsumers: ['src/com/google/common/base/Client.java']
        }
      });
    } else if (mod >= 7 && mod <= 8) {
      // Multi-Module Reactor (60 cases): guava-base -> guava-collections
      const isBreaking = mod === 8;
      cases.push({
        id,
        category: 'GUAVA_MULTI_MODULE_REACTOR',
        description: `Guava multi-module reactor ${isBreaking ? 'breaking' : 'compatible'} #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version><modules><module>guava-base</module><module>guava-collect</module></modules></project>',
          'guava-base/pom.xml': '<project><parent><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version></parent><artifactId>guava-base</artifactId></project>',
          'guava-base/src/com/google/common/base/Predicate.java': `package com.google.common.base;\npublic interface Predicate {\n  boolean apply(Object input);\n}`,
          'guava-collect/pom.xml': '<project><parent><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version></parent><artifactId>guava-collect</artifactId><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava-base</artifactId></dependency></dependencies></project>',
          'guava-collect/src/com/google/common/collect/Filter.java': `package com.google.common.collect;\nimport com.google.common.base.Predicate;\npublic class Filter {\n  public void filter(Predicate p) { p.apply(null); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version><modules><module>guava-base</module><module>guava-collect</module></modules></project>',
          'guava-base/pom.xml': '<project><parent><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version></parent><artifactId>guava-base</artifactId></project>',
          'guava-base/src/com/google/common/base/Predicate.java': isBreaking
            ? `package com.google.common.base;\npublic interface Predicate {\n  boolean apply(Object input);\n  boolean test(Object input);\n}`
            : `package com.google.common.base;\npublic interface Predicate {\n  boolean apply(Object input);\n}`,
          'guava-collect/pom.xml': '<project><parent><groupId>com.google.guava</groupId><artifactId>guava-parent</artifactId><version>1.0.0</version></parent><artifactId>guava-collect</artifactId><dependencies><dependency><groupId>com.google.guava</groupId><artifactId>guava-base</artifactId></dependency></dependencies></project>',
          'guava-collect/src/com/google/common/collect/Filter.java': `package com.google.common.collect;\nimport com.google.common.base.Predicate;\npublic class Filter {\n  public void filter(Predicate p) { p.apply(null); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: isBreaking ? 'INCOMPATIBLE' : 'COMPATIBLE',
          goldConsumers: ['guava-collect/src/com/google/common/collect/Filter.java'],
          goldBreakingConsumers: isBreaking ? ['guava-collect/src/com/google/common/collect/Filter.java'] : []
        }
      });
    } else {
      // Disqualified (30 cases): Wildcard imports or reflection
      cases.push({
        id,
        category: 'GUAVA_DISQUALIFIED',
        description: `Guava with wildcard import or dynamic build #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>',
          'src/com/google/common/Test.java': `package com.google.common;\nimport java.util.*;\npublic class Test {}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>',
          'src/com/google/common/Test.java': `package com.google.common;\nimport java.util.*;\npublic class Test { public void foo() {} }`
        },
        goldSet: {
          expectedQualification: 'RETAINED_IN_ADVISORY',
          expectedVerdict: 'INCONCLUSIVE',
          goldConsumers: [],
          goldBreakingConsumers: []
        }
      });
    }
  }

  // =========================================================================
  // FAMILY 2: JACKSON ECOSYSTEM (350 cases: jackson-001 to jackson-350)
  // Data Binding, JSON Streaming, Property Mappings, Reactor Trees
  // =========================================================================
  for (let i = 1; i <= 350; i++) {
    const id = `jackson-${String(i).padStart(3, '0')}`;
    const mod = i % 10;

    if (mod >= 0 && mod <= 3) {
      // Clean Compatible (140 cases): Adding serializer methods or properties
      cases.push({
        id,
        category: 'JACKSON_CLEAN_COMPATIBLE',
        description: `Jackson ObjectMapper feature addition #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.15.0</version></project>',
          'src/com/fasterxml/jackson/databind/ObjectMapper.java': `package com.fasterxml.jackson.databind;\npublic class ObjectMapper {\n  public String writeValueAsString(Object value) { return ""; }\n}`,
          'src/com/fasterxml/jackson/databind/JsonWriter.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class JsonWriter {\n  public void write(ObjectMapper mapper, Object val) { mapper.writeValueAsString(val); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.15.0</version></project>',
          'src/com/fasterxml/jackson/databind/ObjectMapper.java': `package com.fasterxml.jackson.databind;\npublic class ObjectMapper {\n  public String writeValueAsString(Object value) { return ""; }\n  public byte[] writeValueAsBytes(Object value) { return new byte[0]; }\n}`,
          'src/com/fasterxml/jackson/databind/JsonWriter.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.databind.ObjectMapper;\npublic class JsonWriter {\n  public void write(ObjectMapper mapper, Object val) { mapper.writeValueAsString(val); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'COMPATIBLE',
          goldConsumers: ['src/com/fasterxml/jackson/databind/JsonWriter.java'],
          goldBreakingConsumers: []
        }
      });
    } else if (mod >= 4 && mod <= 6) {
      // Clean Breaking (105 cases): Field type changes, signature removals, final additions
      const isFinal = mod === 6;
      cases.push({
        id,
        category: 'JACKSON_CLEAN_BREAKING',
        description: isFinal ? `Jackson class made final #${i}` : `Jackson method signature broken #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.15.0</version></project>',
          'src/com/fasterxml/jackson/databind/JsonSerializer.java': `package com.fasterxml.jackson.databind;\npublic class JsonSerializer {\n  public void serialize(Object obj) {}\n}`,
          'src/com/fasterxml/jackson/databind/CustomSerializer.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.databind.JsonSerializer;\npublic class CustomSerializer extends JsonSerializer {\n  public void run() { serialize(null); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>2.15.0</version></project>',
          'src/com/fasterxml/jackson/databind/JsonSerializer.java': isFinal
            ? `package com.fasterxml.jackson.databind;\npublic final class JsonSerializer {\n  public void serialize(Object obj) {}\n}`
            : `package com.fasterxml.jackson.databind;\npublic class JsonSerializer {\n  public void serialize(String obj) {}\n}`,
          'src/com/fasterxml/jackson/databind/CustomSerializer.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.databind.JsonSerializer;\npublic class CustomSerializer extends JsonSerializer {\n  public void run() { serialize(null); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'INCOMPATIBLE',
          goldConsumers: ['src/com/fasterxml/jackson/databind/CustomSerializer.java'],
          goldBreakingConsumers: ['src/com/fasterxml/jackson/databind/CustomSerializer.java']
        }
      });
    } else if (mod >= 7 && mod <= 8) {
      // Multi-Module Reactor (70 cases): jackson-core -> jackson-databind
      const isBreaking = mod === 8;
      cases.push({
        id,
        category: 'JACKSON_MULTI_MODULE_REACTOR',
        description: `Jackson reactor ${isBreaking ? 'breaking' : 'compatible'} #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version><modules><module>jackson-core</module><module>jackson-databind</module></modules></project>',
          'jackson-core/pom.xml': '<project><parent><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version></parent><artifactId>jackson-core</artifactId></project>',
          'jackson-core/src/com/fasterxml/jackson/core/JsonParser.java': `package com.fasterxml.jackson.core;\npublic class JsonParser {\n  public String getText() { return ""; }\n}`,
          'jackson-databind/pom.xml': '<project><parent><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version></parent><artifactId>jackson-databind</artifactId><dependencies><dependency><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-core</artifactId></dependency></dependencies></project>',
          'jackson-databind/src/com/fasterxml/jackson/databind/Deserializer.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.core.JsonParser;\npublic class Deserializer {\n  public String deserialize(JsonParser p) { return p.getText(); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version><modules><module>jackson-core</module><module>jackson-databind</module></modules></project>',
          'jackson-core/pom.xml': '<project><parent><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version></parent><artifactId>jackson-core</artifactId></project>',
          'jackson-core/src/com/fasterxml/jackson/core/JsonParser.java': isBreaking
            ? `package com.fasterxml.jackson.core;\npublic class JsonParser {\n  public byte[] getText() { return new byte[0]; }\n}`
            : `package com.fasterxml.jackson.core;\npublic class JsonParser {\n  public String getText() { return ""; }\n  public int getNumber() { return 0; }\n}`,
          'jackson-databind/pom.xml': '<project><parent><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-base</artifactId><version>1.0.0</version></parent><artifactId>jackson-databind</artifactId><dependencies><dependency><groupId>com.fasterxml.jackson</groupId><artifactId>jackson-core</artifactId></dependency></dependencies></project>',
          'jackson-databind/src/com/fasterxml/jackson/databind/Deserializer.java': `package com.fasterxml.jackson.databind;\nimport com.fasterxml.jackson.core.JsonParser;\npublic class Deserializer {\n  public String deserialize(JsonParser p) { return p.getText(); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: isBreaking ? 'INCOMPATIBLE' : 'COMPATIBLE',
          goldConsumers: ['jackson-databind/src/com/fasterxml/jackson/databind/Deserializer.java'],
          goldBreakingConsumers: isBreaking ? ['jackson-databind/src/com/fasterxml/jackson/databind/Deserializer.java'] : []
        }
      });
    } else {
      // Disqualified (35 cases): Codegen / dynamic build / wildcard
      cases.push({
        id,
        category: 'JACKSON_DISQUALIFIED',
        description: `Jackson with wildcard or dynamic gradle script #${i}`,
        historicalFiles: {
          'build.gradle': `allprojects { println "Dynamic script" }\nsubprojects.findAll { it.name.startsWith("ext") }`,
          'src/com/fasterxml/jackson/Type.java': `package com.fasterxml.jackson;\npublic class Type {}`
        },
        candidateFiles: {
          'build.gradle': `allprojects { println "Dynamic script" }\nsubprojects.findAll { it.name.startsWith("ext") }`,
          'src/com/fasterxml/jackson/Type.java': `package com.fasterxml.jackson;\npublic class Type {}`
        },
        goldSet: {
          expectedQualification: 'RETAINED_IN_ADVISORY',
          expectedVerdict: 'INCONCLUSIVE',
          goldConsumers: [],
          goldBreakingConsumers: []
        }
      });
    }
  }

  // =========================================================================
  // FAMILY 3: SPRING FRAMEWORK (350 cases: spring-001 to spring-350)
  // Dependency Injection, Lifecycle Interfaces, Multi-Tier Reactors
  // =========================================================================
  for (let i = 1; i <= 350; i++) {
    const id = `spring-${String(i).padStart(3, '0')}`;
    const mod = i % 10;

    if (mod >= 0 && mod <= 3) {
      // Clean Compatible (140 cases): Adding spring beans, helper methods, configurations
      cases.push({
        id,
        category: 'SPRING_CLEAN_COMPATIBLE',
        description: `Spring ApplicationContext helper addition #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>6.1.0</version></project>',
          'src/org/springframework/context/ApplicationContext.java': `package org.springframework.context;\npublic class ApplicationContext {\n  public Object getBean(String name) { return null; }\n}`,
          'src/org/springframework/context/ClientBean.java': `package org.springframework.context;\nimport org.springframework.context.ApplicationContext;\npublic class ClientBean {\n  public void init(ApplicationContext ctx) { ctx.getBean("x"); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>6.1.0</version></project>',
          'src/org/springframework/context/ApplicationContext.java': `package org.springframework.context;\npublic class ApplicationContext {\n  public Object getBean(String name) { return null; }\n  public boolean containsBean(String name) { return true; }\n}`,
          'src/org/springframework/context/ClientBean.java': `package org.springframework.context;\nimport org.springframework.context.ApplicationContext;\npublic class ClientBean {\n  public void init(ApplicationContext ctx) { ctx.getBean("x"); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'COMPATIBLE',
          goldConsumers: ['src/org/springframework/context/ClientBean.java'],
          goldBreakingConsumers: []
        }
      });
    } else if (mod >= 4 && mod <= 6) {
      // Clean Breaking (105 cases): Interface method added without default or visibility narrowed
      const isInterfaceMethod = mod === 4 || mod === 5;
      cases.push({
        id,
        category: 'SPRING_CLEAN_BREAKING',
        description: isInterfaceMethod ? `Spring interface abstract method added #${i}` : `Spring method visibility narrowed #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-beans</artifactId><version>6.1.0</version></project>',
          'src/org/springframework/beans/InitializingBean.java': `package org.springframework.beans;\npublic interface InitializingBean {\n  void afterPropertiesSet();\n}`,
          'src/org/springframework/beans/CustomBean.java': `package org.springframework.beans;\nimport org.springframework.beans.InitializingBean;\npublic class CustomBean implements InitializingBean {\n  public void afterPropertiesSet() {}\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-beans</artifactId><version>6.1.0</version></project>',
          'src/org/springframework/beans/InitializingBean.java': isInterfaceMethod
            ? `package org.springframework.beans;\npublic interface InitializingBean {\n  void afterPropertiesSet();\n  void destroy();\n}`
            : `package org.springframework.beans;\ninterface InitializingBean {\n  void afterPropertiesSet();\n}`,
          'src/org/springframework/beans/CustomBean.java': `package org.springframework.beans;\nimport org.springframework.beans.InitializingBean;\npublic class CustomBean implements InitializingBean {\n  public void afterPropertiesSet() {}\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: 'INCOMPATIBLE',
          goldConsumers: ['src/org/springframework/beans/CustomBean.java'],
          goldBreakingConsumers: ['src/org/springframework/beans/CustomBean.java']
        }
      });
    } else if (mod >= 7 && mod <= 8) {
      // Multi-Module Reactor (70 cases): spring-core -> spring-beans -> spring-context
      const isBreaking = mod === 8;
      cases.push({
        id,
        category: 'SPRING_MULTI_MODULE_REACTOR',
        description: `Spring 3-tier reactor ${isBreaking ? 'breaking' : 'compatible'} #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version><modules><module>spring-core</module><module>spring-beans</module></modules></project>',
          'spring-core/pom.xml': '<project><parent><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version></parent><artifactId>spring-core</artifactId></project>',
          'spring-core/src/org/springframework/core/Assert.java': `package org.springframework.core;\npublic class Assert {\n  public static void notNull(Object o) {}\n}`,
          'spring-beans/pom.xml': '<project><parent><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version></parent><artifactId>spring-beans</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency></dependencies></project>',
          'spring-beans/src/org/springframework/beans/BeanUtils.java': `package org.springframework.beans;\nimport org.springframework.core.Assert;\npublic class BeanUtils {\n  public void instantiate(Object o) { Assert.notNull(o); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version><modules><module>spring-core</module><module>spring-beans</module></modules></project>',
          'spring-core/pom.xml': '<project><parent><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version></parent><artifactId>spring-core</artifactId></project>',
          'spring-core/src/org/springframework/core/Assert.java': isBreaking
            ? `package org.springframework.core;\npublic class Assert {\n  public static void notNull(Object o, String msg) {}\n}`
            : `package org.springframework.core;\npublic class Assert {\n  public static void notNull(Object o) {}\n  public static void state(boolean b) {}\n}`,
          'spring-beans/pom.xml': '<project><parent><groupId>org.springframework</groupId><artifactId>spring-parent</artifactId><version>1.0.0</version></parent><artifactId>spring-beans</artifactId><dependencies><dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></dependency></dependencies></project>',
          'spring-beans/src/org/springframework/beans/BeanUtils.java': `package org.springframework.beans;\nimport org.springframework.core.Assert;\npublic class BeanUtils {\n  public void instantiate(Object o) { Assert.notNull(o); }\n}`
        },
        goldSet: {
          expectedQualification: 'QUALIFIED_FOR_CERTIFIED_F0',
          expectedVerdict: isBreaking ? 'INCOMPATIBLE' : 'COMPATIBLE',
          goldConsumers: ['spring-beans/src/org/springframework/beans/BeanUtils.java'],
          goldBreakingConsumers: isBreaking ? ['spring-beans/src/org/springframework/beans/BeanUtils.java'] : []
        }
      });
    } else {
      // Disqualified (35 cases): Class.forName reflection
      cases.push({
        id,
        category: 'SPRING_DISQUALIFIED',
        description: `Spring with reflection Class.forName #${i}`,
        historicalFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></project>',
          'src/org/springframework/Reflector.java': `package org.springframework;\npublic class Reflector {\n  public Object create() throws Exception { return Class.forName("com.Foo").newInstance(); }\n}`
        },
        candidateFiles: {
          'pom.xml': '<project><groupId>org.springframework</groupId><artifactId>spring-core</artifactId></project>',
          'src/org/springframework/Reflector.java': `package org.springframework;\npublic class Reflector {\n  public Object create() throws Exception { return Class.forName("com.Bar").newInstance(); }\n}`
        },
        goldSet: {
          expectedQualification: 'RETAINED_IN_ADVISORY',
          expectedVerdict: 'INCONCLUSIVE',
          goldConsumers: [],
          goldBreakingConsumers: []
        }
      });
    }
  }

  return cases;
}

// Generate file if executed directly
if (require.main === module) {
  const cases = generateJavaScale1000Cases();
  const targetPath = path.resolve(__dirname, 'fixtures/java_scale_manifest_1000.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(cases, null, 2), 'utf8');
  console.log(`Generated ${cases.length} cases at ${targetPath}`);
}
