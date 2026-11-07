import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

interface GroundTruthConsumer {
  consumerId: string;
  consumerFqcn: string;
  consumerFile: string;
  location: string;
  bindingKind: string;
  historicalBehavior: string;
  candidateBehavior: string;
  sourceCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  binaryCompatibility: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  runtimeBehavior: string;
  compilerEvidence: string;
  isScopeComplete: boolean;
}

interface RealJavaEvalCase {
  caseId: string;
  repo: string;
  commitSha: string;
  subject: string;
  javaVersion: number;
  buildSystem: 'MAVEN' | 'GRADLE';
  isMultiModule: boolean;
  changeType: string;
  expectedQualification: string;
  expectedPrimaryBlocker: string;
  historicalFiles: Record<string, string>;
  candidateFiles: Record<string, string>;
  groundTruthConsumers: GroundTruthConsumer[];
}

export interface BinaryVerificationResult {
  caseId: string;
  consumerId: string;
  consumerFqcn: string;
  gtBinaryExpected: string;
  empiricallyObserved: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE';
  linkageError?: string;
  stdout?: string;
  passed: boolean;
}

const HARNESS_JAVA_SOURCE = `
package com.sajimora.test;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

public class BinaryLinkageHarness {
    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("Usage: BinaryLinkageHarness <consumerFqcn>");
            System.exit(2);
        }
        String fqcn = args[0];
        try {
            // Load class and force complete linkage and resolution
            Class<?> clazz = Class.forName(fqcn, true, BinaryLinkageHarness.class.getClassLoader());
            
            // Look for any declared public or package methods to invoke
            Method targetMethod = null;
            for (Method m : clazz.getDeclaredMethods()) {
                if (!Modifier.isPrivate(m.getModifiers()) && !m.getName().contains("$")) {
                    targetMethod = m;
                    break;
                }
            }

            if (targetMethod != null) {
                targetMethod.setAccessible(true);
                Object instance = null;
                if (!Modifier.isStatic(targetMethod.getModifiers())) {
                    try {
                        var ctor = clazz.getDeclaredConstructor();
                        ctor.setAccessible(true);
                        instance = ctor.newInstance();
                    } catch (Throwable t) {
                        // If no default constructor, instantiate via Unsafe or dummy
                    }
                }

                // If instance available or static, attempt invocation with dummy args
                if (instance != null || Modifier.isStatic(targetMethod.getModifiers())) {
                    Object[] dummyArgs = new Object[targetMethod.getParameterCount()];
                    Class<?>[] pTypes = targetMethod.getParameterTypes();
                    for (int i = 0; i < pTypes.length; i++) {
                        if (pTypes[i] == int.class) dummyArgs[i] = 0;
                        else if (pTypes[i] == boolean.class) dummyArgs[i] = false;
                        else if (pTypes[i] == long.class) dummyArgs[i] = 0L;
                        else dummyArgs[i] = null;
                    }
                    try {
                        targetMethod.invoke(instance, dummyArgs);
                    } catch (java.lang.reflect.InvocationTargetException ite) {
                        Throwable cause = ite.getCause();
                        if (cause instanceof LinkageError) {
                            throw (LinkageError) cause;
                        }
                    }
                }
            }

            System.out.println("LINKAGE_SUCCESS: Class " + fqcn + " resolved and linked successfully.");
            System.exit(0);
        } catch (LinkageError le) {
            System.err.println("LINKAGE_ERROR: " + le.getClass().getName() + ": " + le.getMessage());
            le.printStackTrace(System.err);
            System.exit(1);
        } catch (Throwable t) {
            System.out.println("NON_LINKAGE_EXCEPTION: " + t.getClass().getName() + ": " + t.getMessage());
            System.exit(0);
        }
    }
}
`;

export function runBinaryGroundTruthVerification(): BinaryVerificationResult[] {
  const fixturePath = path.resolve(__dirname, 'fixtures/real_java_api_changes_eval.json');
  const cases: RealJavaEvalCase[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const tempRoot = path.resolve(process.cwd(), 'temp_binary_eval');
  if (fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(tempRoot, { recursive: true });

  // Compile the Harness
  const harnessDir = path.join(tempRoot, 'harness');
  const harnessSrcDir = path.join(harnessDir, 'src/com/sajimora/test');
  fs.mkdirSync(harnessSrcDir, { recursive: true });
  fs.writeFileSync(path.join(harnessSrcDir, 'BinaryLinkageHarness.java'), HARNESS_JAVA_SOURCE, 'utf8');
  execSync(`javac -d "${harnessDir}" "${path.join(harnessSrcDir, 'BinaryLinkageHarness.java')}"`);

  const results: BinaryVerificationResult[] = [];

  for (const c of cases) {
    console.log(`[CASE ${c.caseId}] Binary Linkage Verification for ${c.repo}...`);
    const caseDir = path.join(tempRoot, c.caseId);
    const parentDir = path.join(caseDir, 'parent');
    const candDir = path.join(caseDir, 'candidate');
    const parentOut = path.join(caseDir, 'parent_out');
    const candOut = path.join(caseDir, 'cand_out');

    fs.mkdirSync(parentDir, { recursive: true });
    fs.mkdirSync(candDir, { recursive: true });
    fs.mkdirSync(parentOut, { recursive: true });
    fs.mkdirSync(candOut, { recursive: true });

    // Write parent files
    const parentJavaFiles: string[] = [];
    for (const [relPath, content] of Object.entries(c.historicalFiles)) {
      if (!relPath.endsWith('.java')) continue;
      const fullPath = path.join(parentDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      parentJavaFiles.push(fullPath);
    }

    // Write candidate files
    const candJavaFiles: string[] = [];
    for (const [relPath, content] of Object.entries(c.candidateFiles)) {
      if (!relPath.endsWith('.java')) continue;
      const fullPath = path.join(candDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
      candJavaFiles.push(fullPath);
    }

    // Compile parent
    let parentCompiled = false;
    try {
      execSync(`javac -d "${parentOut}" ${parentJavaFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'pipe' });
      parentCompiled = true;
    } catch (e: any) {
      // Missing external dependencies or Lombok
    }

    // Compile candidate
    let candCompiled = false;
    try {
      execSync(`javac -d "${candOut}" ${candJavaFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'pipe' });
      candCompiled = true;
    } catch (e: any) {
      // In some candidate cases, incompatible consumers fail to compile!
      // In that case, we compile candidate API files only so candidate classes exist
      const candidateApiFiles = candJavaFiles.filter(f => {
        const isConsumer = c.groundTruthConsumers.some(gt => f.endsWith(path.normalize(gt.consumerFile)));
        return !isConsumer;
      });
      if (candidateApiFiles.length > 0) {
        try {
          execSync(`javac -d "${candOut}" ${candidateApiFiles.map(f => `"${f}"`).join(' ')}`, { stdio: 'pipe' });
          candCompiled = true;
        } catch {}
      }
    }

    for (const gt of c.groundTruthConsumers) {
      if (!parentCompiled || !candCompiled) {
        results.push({
          caseId: c.caseId,
          consumerId: gt.consumerId,
          consumerFqcn: gt.consumerFqcn,
          gtBinaryExpected: gt.binaryCompatibility,
          empiricallyObserved: 'INCONCLUSIVE',
          linkageError: 'Source failed compilation (external dependency, Lombok, or modern construct)',
          passed: gt.binaryCompatibility === 'INCONCLUSIVE'
        });
        continue;
      }

      // Check if parent compiled consumer class exists
      const consumerClassRel = gt.consumerFqcn.replace(/\./g, '/') + '.class';
      const parentConsumerClass = path.join(parentOut, consumerClassRel);
      if (!fs.existsSync(parentConsumerClass)) {
        results.push({
          caseId: c.caseId,
          consumerId: gt.consumerId,
          consumerFqcn: gt.consumerFqcn,
          gtBinaryExpected: gt.binaryCompatibility,
          empiricallyObserved: 'INCONCLUSIVE',
          linkageError: `Compiled class ${consumerClassRel} not found in parent output`,
          passed: gt.binaryCompatibility === 'INCONCLUSIVE'
        });
        continue;
      }

      // Now run JVM: classpath = candidate output (candidate API) + parent consumer output + harness
      // Candidate output MUST be first in classpath so candidate API classes shadow parent API classes!
      const cp = `"${candOut}";"${parentOut}";"${harnessDir}"`;
      let observed: 'COMPATIBLE' | 'INCOMPATIBLE' | 'INCONCLUSIVE' = 'COMPATIBLE';
      let errorStr: string | undefined;
      let outStr: string | undefined;

      try {
        const out = execSync(`java -cp ${cp} com.sajimora.test.BinaryLinkageHarness "${gt.consumerFqcn}"`, {
          stdio: 'pipe',
          timeout: 5000
        });
        outStr = out.toString();
        observed = 'COMPATIBLE';
      } catch (err: any) {
        const stderr = err.stderr ? err.stderr.toString() : '';
        const stdout = err.stdout ? err.stdout.toString() : '';
        outStr = stdout;
        errorStr = stderr || stdout;
        if (stderr.includes('LINKAGE_ERROR') || stderr.includes('NoSuchMethodError') ||
            stderr.includes('IllegalAccessError') || stderr.includes('AbstractMethodError') ||
            stderr.includes('IncompatibleClassChangeError') || stderr.includes('NoClassDefFoundError')) {
          observed = 'INCOMPATIBLE';
        } else {
          observed = 'INCONCLUSIVE';
        }
      }

      const passed = observed === gt.binaryCompatibility;
      results.push({
        caseId: c.caseId,
        consumerId: gt.consumerId,
        consumerFqcn: gt.consumerFqcn,
        gtBinaryExpected: gt.binaryCompatibility,
        empiricallyObserved: observed,
        linkageError: errorStr ? errorStr.split('\n')[0] : undefined,
        stdout: outStr ? outStr.split('\n')[0] : undefined,
        passed
      });
    }
  }

  // Cleanup tempRoot
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}

  return results;
}

const res = runBinaryGroundTruthVerification();
console.log('\n================================================================');
console.log('         JVM BYTECODE BINARY GROUND-TRUTH VERIFICATION          ');
console.log('================================================================');
let passCount = 0;
for (const r of res) {
  const status = r.passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} [${r.caseId}][${r.consumerId}] Expected: ${r.gtBinaryExpected} | Observed: ${r.empiricallyObserved} | Detail: ${r.linkageError ?? r.stdout ?? 'Clean'}`);
  if (r.passed) passCount++;
}
console.log(`\nBinary Ground-Truth Agreement: ${passCount} / ${res.length} (${((passCount / res.length) * 100).toFixed(1)}%)`);
