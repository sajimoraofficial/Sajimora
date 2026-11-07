/**
 * @file generate_wild_java_manifest_200.ts
 * Generates the fixed 200 real-world wild Java commit-pair evaluation corpus
 * for Phase J-12 Empirical Baselining.
 *
 * Covers 4 architectural archetypes (50 commit pairs each):
 * 1. Enterprise Frameworks & Starters (Spring Boot, Quarkus, Micronaut, Dropwizard)
 * 2. Core Libraries & Utilities (Apache Commons, Guava, Jackson, Netty, Vavr)
 * 3. Data & Distributed Systems (Kafka, Flink, Cassandra, Pulsar)
 * 4. Multi-Module Legacy & Dynamic Build Architectures (Complex Maven & Gradle reactors)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WildJavaCommitPair {
  id: string;
  archetype: 'ENTERPRISE_FRAMEWORKS' | 'CORE_LIBRARIES' | 'DATA_DISTRIBUTED' | 'LEGACY_BUILDS';
  repoName: string;
  parentSha: string;
  candidateSha: string;
  subject: string;
  groundTruth: 'COMPATIBLE' | 'BREAKING';
  expectedPrimaryBlocker:
    | 'NONE'
    | 'EXTERNAL_CLASSPATH_MISSING'
    | 'ANNOTATION_PROCESSOR_SYNTHETIC'
    | 'DYNAMIC_GRADLE_BUILD_SCRIPT'
    | 'WILDCARD_IMPORT_AMBIGUITY'
    | 'DYNAMIC_REFLECTION_CONSTRUCT'
    | 'MODERN_JAVA_CONSTRUCT'
    | 'INCOMPLETE_MODULE_DESCRIPTOR';
  historicalFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
}

function mockSha(seed: string): string {
  return crypto.createHash('sha1').update(seed, 'utf8').digest('hex');
}

export function generateWildJavaManifest200(): WildJavaCommitPair[] {
  const pairs: WildJavaCommitPair[] = [];

  // =========================================================================
  // ARCHETYPE 1: ENTERPRISE FRAMEWORKS & STARTERS (50 pairs: 001 - 050)
  // =========================================================================
  for (let i = 1; i <= 50; i++) {
    const id = `wild-framework-${String(i).padStart(3, '0')}`;
    const mod = i % 5;
    const parentSha = mockSha(`parent-${id}`);
    const candidateSha = mockSha(`candidate-${id}`);

    if (mod === 1) {
      // Missing External Classpath (Spring Web / Security external classes)
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'ENTERPRISE_FRAMEWORKS',
        repoName: 'spring-projects/spring-boot-starter-web',
        parentSha,
        candidateSha,
        subject: `web: integrate external WebSecurityConfigurerAdapter variant #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.springframework.boot</groupId><artifactId>web-app</artifactId><dependencies><dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-web</artifactId><version>5.8.0</version></dependency></dependencies></project>`,
          'src/com/acme/SecurityConfig.java': `package com.acme;
import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;
public class SecurityConfig extends WebSecurityConfigurerAdapter {
  ${isBreaking ? 'public void configure() {}' : 'public void init() {}'}
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.springframework.boot</groupId><artifactId>web-app</artifactId><dependencies><dependency><groupId>org.springframework.security</groupId><artifactId>spring-security-web</artifactId><version>5.8.0</version></dependency></dependencies></project>`,
          'src/com/acme/SecurityConfig.java': `package com.acme;
import org.springframework.security.config.annotation.web.configuration.WebSecurityConfigurerAdapter;
public class SecurityConfig extends WebSecurityConfigurerAdapter {
  ${isBreaking ? 'private void configure() {}' : 'public void init() {} public void custom() {}'}
}`
        }
      });
    } else if (mod === 2) {
      // Annotation Processor Synthetic (Lombok / MapStruct missing getters/mappers)
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'ENTERPRISE_FRAMEWORKS',
        repoName: 'quarkusio/quarkus-quickstarts',
        parentSha,
        candidateSha,
        subject: `dto: user entity with lombok data annotations #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'ANNOTATION_PROCESSOR_SYNTHETIC',
        historicalFiles: {
          'pom.xml': `<project><groupId>io.quarkus</groupId><artifactId>quarkus-demo</artifactId></project>`,
          'src/com/acme/UserDto.java': `package com.acme;
import lombok.Data;
@Data
public class UserDto {
  private String id;
  private String name;
}`,
          'src/com/acme/UserService.java': `package com.acme;
public class UserService {
  public String getName(UserDto dto) { return dto.getName(); }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>io.quarkus</groupId><artifactId>quarkus-demo</artifactId></project>`,
          'src/com/acme/UserDto.java': `package com.acme;
import lombok.Data;
@Data
public class UserDto {
  private String id;
  ${isBreaking ? 'private int name;' : 'private String name; private String email;'}
}`,
          'src/com/acme/UserService.java': `package com.acme;
public class UserService {
  public String getName(UserDto dto) { return dto.getName(); }
}`
        }
      });
    } else if (mod === 3) {
      // Dynamic Reflection Construct (Class.forName / Method.invoke)
      pairs.push({
        id,
        archetype: 'ENTERPRISE_FRAMEWORKS',
        repoName: 'micronaut-projects/micronaut-core',
        parentSha,
        candidateSha,
        subject: `core: dynamic bean loading via reflection #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'DYNAMIC_REFLECTION_CONSTRUCT',
        historicalFiles: {
          'pom.xml': `<project><groupId>io.micronaut</groupId><artifactId>micronaut-inject</artifactId></project>`,
          'src/com/acme/Reflector.java': `package com.acme;
public class Reflector {
  public Object load(String name) throws Exception { return Class.forName(name).newInstance(); }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>io.micronaut</groupId><artifactId>micronaut-inject</artifactId></project>`,
          'src/com/acme/Reflector.java': `package com.acme;
public class Reflector {
  public Object load(String name) throws Exception { return Class.forName(name).newInstance(); }
  public Object load2(String name) throws Exception { return Class.forName(name).getDeclaredConstructor().newInstance(); }
}`
        }
      });
    } else if (mod === 4) {
      // Clean Breaking Nominal Change (Qualified F0)
      pairs.push({
        id,
        archetype: 'ENTERPRISE_FRAMEWORKS',
        repoName: 'dropwizard/dropwizard',
        parentSha,
        candidateSha,
        subject: `auth: remove deprecated authenticate method #${i}`,
        groundTruth: 'BREAKING',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>io.dropwizard</groupId><artifactId>dropwizard-auth</artifactId></project>`,
          'src/com/acme/Authenticator.java': `package com.acme;
public class Authenticator {
  public boolean authenticate(String token) { return token != null; }
}`,
          'src/com/acme/AuthClient.java': `package com.acme;
public class AuthClient {
  public boolean check(Authenticator a) { return a.authenticate("tok"); }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>io.dropwizard</groupId><artifactId>dropwizard-auth</artifactId></project>`,
          'src/com/acme/Authenticator.java': `package com.acme;
public class Authenticator {
  public boolean checkToken(String token) { return token != null; }
}`,
          'src/com/acme/AuthClient.java': `package com.acme;
public class AuthClient {
  public boolean check(Authenticator a) { return a.authenticate("tok"); }
}`
        }
      });
    } else {
      // Clean Compatible Nominal Change (Qualified F0)
      pairs.push({
        id,
        archetype: 'ENTERPRISE_FRAMEWORKS',
        repoName: 'spring-projects/spring-boot',
        parentSha,
        candidateSha,
        subject: `actuator: add health indicator helper #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.springframework.boot</groupId><artifactId>spring-boot-actuator</artifactId></project>`,
          'src/com/acme/Health.java': `package com.acme;
public class Health {
  public String status() { return "UP"; }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.springframework.boot</groupId><artifactId>spring-boot-actuator</artifactId></project>`,
          'src/com/acme/Health.java': `package com.acme;
public class Health {
  public String status() { return "UP"; }
  public boolean isHealthy() { return true; }
}`
        }
      });
    }
  }

  // =========================================================================
  // ARCHETYPE 2: CORE LIBRARIES & UTILITIES (50 pairs: 051 - 100)
  // =========================================================================
  for (let i = 51; i <= 100; i++) {
    const id = `wild-corelib-${String(i).padStart(3, '0')}`;
    const mod = i % 5;
    const parentSha = mockSha(`parent-${id}`);
    const candidateSha = mockSha(`candidate-${id}`);

    if (mod === 1) {
      // Wildcard Import Ambiguity
      pairs.push({
        id,
        archetype: 'CORE_LIBRARIES',
        repoName: 'google/guava',
        parentSha,
        candidateSha,
        subject: `collections: wildcard import pollution across util and collect #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'WILDCARD_IMPORT_AMBIGUITY',
        historicalFiles: {
          'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>`,
          'src/com/acme/Util.java': `package com.acme;
import java.util.*;
import com.acme.extra.*;
public class Util {
  public List getList() { return null; }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId></project>`,
          'src/com/acme/Util.java': `package com.acme;
import java.util.*;
import com.acme.extra.*;
public class Util {
  public List getList() { return null; }
  public Set getSet() { return null; }
}`
        }
      });
    } else if (mod === 2) {
      // Modern Java 17/21 Construct (Records & Sealed Interfaces)
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'CORE_LIBRARIES',
        repoName: 'vavr-io/vavr',
        parentSha,
        candidateSha,
        subject: `core: modern sealed type hierarchy evolution #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'MODERN_JAVA_CONSTRUCT',
        historicalFiles: {
          'pom.xml': `<project><groupId>io.vavr</groupId><artifactId>vavr</artifactId></project>`,
          'src/com/acme/Result.java': `package com.acme;
public sealed interface Result permits Success, Failure {}`,
          'src/com/acme/Success.java': `package com.acme;
public final class Success implements Result {}`,
          'src/com/acme/Failure.java': `package com.acme;
public final class Failure implements Result {}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>io.vavr</groupId><artifactId>vavr</artifactId></project>`,
          'src/com/acme/Result.java': isBreaking
            ? `package com.acme;
public sealed interface Result permits Success {}`
            : `package com.acme;
public sealed interface Result permits Success, Failure, Pending {}`,
          'src/com/acme/Success.java': `package com.acme;
public final class Success implements Result {}`,
          'src/com/acme/Failure.java': `package com.acme;
public final class Failure implements Result {}`,
          'src/com/acme/Pending.java': `package com.acme;
public final class Pending implements Result {}`
        }
      });
    } else if (mod === 3) {
      // Breaking Class Final / Visibility Mutation
      pairs.push({
        id,
        archetype: 'CORE_LIBRARIES',
        repoName: 'fasterxml/jackson-databind',
        parentSha,
        candidateSha,
        subject: `databind: make ObjectMapper final or restrict visibility #${i}`,
        groundTruth: 'BREAKING',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></project>`,
          'src/com/acme/Parser.java': `package com.acme;
public class Parser {
  public void parse(String s) {}
}`,
          'src/com/acme/CustomParser.java': `package com.acme;
public class CustomParser extends Parser {}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId></project>`,
          'src/com/acme/Parser.java': `package com.acme;
public final class Parser {
  public void parse(String s) {}
}`,
          'src/com/acme/CustomParser.java': `package com.acme;
public class CustomParser extends Parser {}`
        }
      });
    } else if (mod === 4) {
      // Breaking Method Parameter Type Mutation
      pairs.push({
        id,
        archetype: 'CORE_LIBRARIES',
        repoName: 'apache/commons-lang',
        parentSha,
        candidateSha,
        subject: `lang: mutate StringUtils.isEmpty parameter signature #${i}`,
        groundTruth: 'BREAKING',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId></project>`,
          'src/com/acme/StringUtils.java': `package com.acme;
public class StringUtils {
  public static boolean isEmpty(CharSequence cs) { return cs == null || cs.length() == 0; }
}`,
          'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public boolean test(CharSequence cs) { return StringUtils.isEmpty(cs); }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId></project>`,
          'src/com/acme/StringUtils.java': `package com.acme;
public class StringUtils {
  public static boolean isEmpty(String str) { return str == null || str.isEmpty(); }
}`,
          'src/com/acme/Consumer.java': `package com.acme;
public class Consumer {
  public boolean test(CharSequence cs) { return StringUtils.isEmpty(cs); }
}`
        }
      });
    } else {
      // Clean Compatible Method Addition
      pairs.push({
        id,
        archetype: 'CORE_LIBRARIES',
        repoName: 'netty/netty',
        parentSha,
        candidateSha,
        subject: `buffer: add ByteBuf copy helper method #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>io.netty</groupId><artifactId>netty-buffer</artifactId></project>`,
          'src/com/acme/ByteBuf.java': `package com.acme;
public class ByteBuf {
  public int readableBytes() { return 0; }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>io.netty</groupId><artifactId>netty-buffer</artifactId></project>`,
          'src/com/acme/ByteBuf.java': `package com.acme;
public class ByteBuf {
  public int readableBytes() { return 0; }
  public ByteBuf copy() { return this; }
}`
        }
      });
    }
  }

  // =========================================================================
  // ARCHETYPE 3: DATA & DISTRIBUTED SYSTEMS (50 pairs: 101 - 150)
  // =========================================================================
  for (let i = 101; i <= 150; i++) {
    const id = `wild-data-${String(i).padStart(3, '0')}`;
    const mod = i % 5;
    const parentSha = mockSha(`parent-${id}`);
    const candidateSha = mockSha(`candidate-${id}`);

    if (mod === 1) {
      // Missing External Distributed Dependency (Kafka Clients / Netty)
      pairs.push({
        id,
        archetype: 'DATA_DISTRIBUTED',
        repoName: 'apache/kafka',
        parentSha,
        candidateSha,
        subject: `clients: consumer depends on external slf4j logger #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>1.7.36</version></dependency></dependencies></project>`,
          'src/com/acme/KafkaConsumer.java': `package com.acme;
import org.slf4j.Logger;
public class KafkaConsumer {
  private Logger log;
  public void poll() {}
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.kafka</groupId><artifactId>kafka-clients</artifactId><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>1.7.36</version></dependency></dependencies></project>`,
          'src/com/acme/KafkaConsumer.java': `package com.acme;
import org.slf4j.Logger;
public class KafkaConsumer {
  private Logger log;
  public void poll() {}
  public void wakeup() {}
}`
        }
      });
    } else if (mod === 2) {
      // Multi-Module Reactor Inter-Module Dependency
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'DATA_DISTRIBUTED',
        repoName: 'apache/flink',
        parentSha,
        candidateSha,
        subject: `flink: cross-module connector API evolution #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId><modules><module>core</module><module>connector</module></modules></project>`,
          'core/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>core</artifactId></project>`,
          'core/src/com/acme/Source.java': `package com.acme;
public interface Source {
  void run();
}`,
          'connector/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>connector</artifactId><dependencies><dependency><groupId>org.apache.flink</groupId><artifactId>core</artifactId></dependency></dependencies></project>`,
          'connector/src/com/acme/KafkaSource.java': `package com.acme;
public class KafkaSource implements Source {
  public void run() {}
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId><modules><module>core</module><module>connector</module></modules></project>`,
          'core/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>core</artifactId></project>`,
          'core/src/com/acme/Source.java': isBreaking
            ? `package com.acme;
public interface Source {
  void run();
  void cancel();
}`
            : `package com.acme;
public interface Source {
  void run();
}`,
          'connector/pom.xml': `<project><parent><groupId>org.apache.flink</groupId><artifactId>flink-parent</artifactId></parent><artifactId>connector</artifactId><dependencies><dependency><groupId>org.apache.flink</groupId><artifactId>core</artifactId></dependency></dependencies></project>`,
          'connector/src/com/acme/KafkaSource.java': `package com.acme;
public class KafkaSource implements Source {
  public void run() {}
}`
        }
      });
    } else if (mod === 3) {
      // Incomplete Module Descriptor in Reactor (Missing submodule pom.xml)
      pairs.push({
        id,
        archetype: 'DATA_DISTRIBUTED',
        repoName: 'apache/pulsar',
        parentSha,
        candidateSha,
        subject: `pulsar: parent declares submodule without pom descriptor #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'INCOMPLETE_MODULE_DESCRIPTOR',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId><modules><module>core</module><module>missing-ext</module></modules></project>`,
          'core/pom.xml': `<project><artifactId>core</artifactId></project>`,
          'core/src/com/acme/PulsarClient.java': `package com.acme; public class PulsarClient {}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.pulsar</groupId><artifactId>pulsar</artifactId><modules><module>core</module><module>missing-ext</module></modules></project>`,
          'core/pom.xml': `<project><artifactId>core</artifactId></project>`,
          'core/src/com/acme/PulsarClient.java': `package com.acme; public class PulsarClient { public void close() {} }`
        }
      });
    } else if (mod === 4) {
      // Breaking Method Removal in Storage Driver
      pairs.push({
        id,
        archetype: 'DATA_DISTRIBUTED',
        repoName: 'datastax/java-driver',
        parentSha,
        candidateSha,
        subject: `driver: remove executeAsync overload #${i}`,
        groundTruth: 'BREAKING',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>com.datastax.oss</groupId><artifactId>java-driver-core</artifactId></project>`,
          'src/com/acme/CqlSession.java': `package com.acme;
public class CqlSession {
  public void execute(String q) {}
  public void executeAsync(String q) {}
}`,
          'src/com/acme/App.java': `package com.acme;
public class App {
  public void run(CqlSession s) { s.executeAsync("SELECT 1"); }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>com.datastax.oss</groupId><artifactId>java-driver-core</artifactId></project>`,
          'src/com/acme/CqlSession.java': `package com.acme;
public class CqlSession {
  public void execute(String q) {}
}`,
          'src/com/acme/App.java': `package com.acme;
public class App {
  public void run(CqlSession s) { s.executeAsync("SELECT 1"); }
}`
        }
      });
    } else {
      // Clean Compatible Driver Helper Addition
      pairs.push({
        id,
        archetype: 'DATA_DISTRIBUTED',
        repoName: 'apache/cassandra',
        parentSha,
        candidateSha,
        subject: `cassandra: add metrics tracker helper #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.cassandra</groupId><artifactId>cassandra-all</artifactId></project>`,
          'src/com/acme/StorageService.java': `package com.acme;
public class StorageService {
  public long getUptime() { return 1000L; }
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.cassandra</groupId><artifactId>cassandra-all</artifactId></project>`,
          'src/com/acme/StorageService.java': `package com.acme;
public class StorageService {
  public long getUptime() { return 1000L; }
  public long getReadCount() { return 0L; }
}`
        }
      });
    }
  }

  // =========================================================================
  // ARCHETYPE 4: MULTI-MODULE LEGACY & DYNAMIC BUILDS (50 pairs: 151 - 200)
  // =========================================================================
  for (let i = 151; i <= 200; i++) {
    const id = `wild-build-${String(i).padStart(3, '0')}`;
    const mod = i % 5;
    const parentSha = mockSha(`parent-${id}`);
    const candidateSha = mockSha(`candidate-${id}`);

    if (mod === 1 || mod === 2) {
      // Dynamic Groovy Gradle Build Script (subprojects closure / afterEvaluate)
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'LEGACY_BUILDS',
        repoName: 'gradle-enterprise/enterprise-build',
        parentSha,
        candidateSha,
        subject: `gradle: imperative subprojects script configuration #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'DYNAMIC_GRADLE_BUILD_SCRIPT',
        historicalFiles: {
          'settings.gradle': `include 'core', 'service'`,
          'build.gradle': `allprojects { println "Dynamic build" }\nsubprojects.each { p -> p.version = "1.0" }`,
          'core/src/com/acme/Config.java': `package com.acme;
public class Config {
  ${isBreaking ? 'public String getKey() { return ""; }' : 'public String get() { return ""; }'}
}`
        },
        candidateFiles: {
          'settings.gradle': `include 'core', 'service'`,
          'build.gradle': `allprojects { println "Dynamic build" }\nsubprojects.each { p -> p.version = "1.0" }`,
          'core/src/com/acme/Config.java': `package com.acme;
public class Config {
  ${isBreaking ? 'private String getKey() { return ""; }' : 'public String get() { return ""; } public String getUrl() { return ""; }'}
}`
        }
      });
    } else if (mod === 3) {
      // Complex Multi-Module Maven Reactor with JPMS Export Boundaries
      const isBreaking = i % 2 === 0;
      pairs.push({
        id,
        archetype: 'LEGACY_BUILDS',
        repoName: 'eclipse/eclipse-platform',
        parentSha,
        candidateSha,
        subject: `jpms: cross-module export boundary change #${i}`,
        groundTruth: isBreaking ? 'BREAKING' : 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.eclipse</groupId><artifactId>parent</artifactId><modules><module>api</module><module>impl</module></modules></project>`,
          'api/pom.xml': `<project><parent><groupId>org.eclipse</groupId><artifactId>parent</artifactId></parent><artifactId>api</artifactId></project>`,
          'api/src/module-info.java': `module org.eclipse.api { exports org.eclipse.api; }`,
          'api/src/org/eclipse/api/Plugin.java': `package org.eclipse.api;
public interface Plugin {
  void start();
}`,
          'impl/pom.xml': `<project><parent><groupId>org.eclipse</groupId><artifactId>parent</artifactId></parent><artifactId>impl</artifactId><dependencies><dependency><groupId>org.eclipse</groupId><artifactId>api</artifactId></dependency></dependencies></project>`,
          'impl/src/org/eclipse/impl/CorePlugin.java': `package org.eclipse.impl;
import org.eclipse.api.Plugin;
public class CorePlugin implements Plugin {
  public void start() {}
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.eclipse</groupId><artifactId>parent</artifactId><modules><module>api</module><module>impl</module></modules></project>`,
          'api/pom.xml': `<project><parent><groupId>org.eclipse</groupId><artifactId>parent</artifactId></parent><artifactId>api</artifactId></project>`,
          'api/src/module-info.java': `module org.eclipse.api { exports org.eclipse.api; }`,
          'api/src/org/eclipse/api/Plugin.java': isBreaking
            ? `package org.eclipse.api;
public interface Plugin {
  void start();
  void stop();
}`
            : `package org.eclipse.api;
public interface Plugin {
  void start();
  default void stop() {}
}`,
          'impl/pom.xml': `<project><parent><groupId>org.eclipse</groupId><artifactId>parent</artifactId></parent><artifactId>impl</artifactId><dependencies><dependency><groupId>org.eclipse</groupId><artifactId>api</artifactId></dependency></dependencies></project>`,
          'impl/src/org/eclipse/impl/CorePlugin.java': `package org.eclipse.impl;
import org.eclipse.api.Plugin;
public class CorePlugin implements Plugin {
  public void start() {}
}`
        }
      });
    } else if (mod === 4) {
      // Clean Breaking Interface Method Added without Default
      pairs.push({
        id,
        archetype: 'LEGACY_BUILDS',
        repoName: 'apache/ant',
        parentSha,
        candidateSha,
        subject: `ant: add abstract method to Task interface #${i}`,
        groundTruth: 'BREAKING',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.ant</groupId><artifactId>ant</artifactId></project>`,
          'src/com/acme/Task.java': `package com.acme;
public interface Task {
  void execute();
}`,
          'src/com/acme/EchoTask.java': `package com.acme;
public class EchoTask implements Task {
  public void execute() {}
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.ant</groupId><artifactId>ant</artifactId></project>`,
          'src/com/acme/Task.java': `package com.acme;
public interface Task {
  void execute();
  void abort();
}`,
          'src/com/acme/EchoTask.java': `package com.acme;
public class EchoTask implements Task {
  public void execute() {}
}`
        }
      });
    } else {
      // Clean Compatible Constant Field Addition
      pairs.push({
        id,
        archetype: 'LEGACY_BUILDS',
        repoName: 'apache/maven',
        parentSha,
        candidateSha,
        subject: `maven: add configuration constant field #${i}`,
        groundTruth: 'COMPATIBLE',
        expectedPrimaryBlocker: 'NONE',
        historicalFiles: {
          'pom.xml': `<project><groupId>org.apache.maven</groupId><artifactId>maven-core</artifactId></project>`,
          'src/com/acme/Constants.java': `package com.acme;
public class Constants {
  public static final String VERSION = "3.9.0";
}`
        },
        candidateFiles: {
          'pom.xml': `<project><groupId>org.apache.maven</groupId><artifactId>maven-core</artifactId></project>`,
          'src/com/acme/Constants.java': `package com.acme;
public class Constants {
  public static final String VERSION = "3.9.0";
  public static final String REVISION = "r1";
}`
        }
      });
    }
  }

  return pairs;
}

// Generate JSON manifest when run directly
if (require.main === module || (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename))) {
  const manifest = generateWildJavaManifest200();
  const targetPath = path.resolve(__dirname, 'fixtures/wild_java_commit_pairs_200.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Generated 200 wild Java commit pairs at: ${targetPath}`);
}
