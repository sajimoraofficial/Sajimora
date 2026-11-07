import { SealedFilesystem } from '../environment/SealedFilesystem';
import { ResolutionFact } from '../../../../../core/src/sajimora/certified/contracts';
import { BlockerCode, VerificationResult } from '../../../../../core/src/sajimora/certified/blockers';
import { ResolverProfileId } from '../../../../../core/src/sajimora/certified/protocol';
import { VerificationBudget } from '../proof/VerificationBudget';

export interface ResolutionProbe {
  logicalPath: string;
  exists: boolean;
}

export interface ResolutionResult {
  outcome: 'RESOLVED' | 'UNRESOLVED' | 'UNSUPPORTED' | 'AMBIGUOUS';
  selectedTargetOrNull: string | null;
  orderedProbes: ResolutionProbe[];
  metadataFileIds: string[];
  blockerCode?: BlockerCode;
  blockerMessage?: string;
}

function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      else return ''; // escaped root
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/'));
}

function dirnamePath(p: string): string {
  const norm = normalizePath(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '' : norm.slice(0, idx);
}

export class F0RestrictedResolver {
  constructor(
    private readonly sealedFs: SealedFilesystem,
    private readonly budget?: VerificationBudget
  ) {}

  /**
   * Independently resolves package imports and relative imports using the strictly frozen
   * F0_NODE10_STATIC_V1 contract.
   * - sealed namespace only
   * - exact types -> typings -> main precedence
   * - first-present field determines the target
   * - NO fallback when the selected field is malformed or does not resolve
   * - malformed package metadata -> UNSUPPORTED_CONFIGURATION
   * - paths / baseUrl -> UNSUPPORTED_CONFIGURATION
   * - conditional exports / imports -> UNSUPPORTED_CONFIGURATION
   * - typesVersions -> UNSUPPORTED_CONFIGURATION
   * - unsupported self-resolution / subpath semantics -> UNSUPPORTED_CONFIGURATION
   */
  public resolve(
    specifier: string,
    containingFile: string,
    compilerOptions?: any
  ): ResolutionResult {
    this.budget?.allocate('WORK_UNITS', 1);

    const orderedProbes: ResolutionProbe[] = [];
    const metadataFileIds: string[] = [];

    const probe = (logicalPath: string): boolean => {
      this.budget?.allocate('WORK_UNITS', 1);
      const exists = this.sealedFs.exists(logicalPath);
      orderedProbes.push({ logicalPath, exists });
      return exists;
    };

    // 1. Narrow sealed tsconfig paths/baseUrl profile.  Configuration is read
    // exclusively from the nearest sealed tsconfig, never from the host.
    const configPath = this.nearestTsconfig(containingFile);
    if (!specifier.startsWith('.') && configPath) {
      const configured = this.resolveSealedPaths(specifier, configPath, probe, metadataFileIds);
      if (configured) return { ...configured, orderedProbes, metadataFileIds };
    }
    if (compilerOptions && (compilerOptions.paths || compilerOptions.baseUrl)) {
      return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes, metadataFileIds,
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: 'Unsealed compiler paths/baseUrl options are not admitted' };
    }

    // 2. Relative imports
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const candidateBase = joinPath(dirnamePath(containingFile), specifier);
      if (!candidateBase) {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          orderedProbes,
          metadataFileIds,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: 'Relative specifier escapes sealed root'
        };
      }

      if (candidateBase.endsWith('.ts') || candidateBase.endsWith('.tsx') || candidateBase.endsWith('.d.ts')) {
        if (probe(candidateBase)) {
          return { outcome: 'RESOLVED', selectedTargetOrNull: candidateBase, orderedProbes, metadataFileIds };
        }
        return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
      }

      // Under NodeNext/Node16 source-mode resolution, an ESM-relative `.js`
      // specifier can name a TypeScript source module which emits to that JS
      // path.  Replay only that finite source correspondence inside the
      // sealed namespace; do not consult the host filesystem or package data.
      const sourceBase = candidateBase.endsWith('.js')
        ? candidateBase.slice(0, -'.js'.length)
        : candidateBase;

      // Check file extensions in order: .ts, .tsx, .d.ts
      for (const ext of ['.ts', '.tsx', '.d.ts']) {
        const p = `${sourceBase}${ext}`;
        if (probe(p)) {
          return { outcome: 'RESOLVED', selectedTargetOrNull: p, orderedProbes, metadataFileIds };
        }
      }

      // Check directory resolution
      const pkgJsonPath = `${candidateBase}/package.json`;
      if (probe(pkgJsonPath)) {
        metadataFileIds.push(pkgJsonPath);
        const pkgRes = this.resolvePackageJson(pkgJsonPath, candidateBase, probe);
        if (pkgRes.blockerCode) {
          return { ...pkgRes, orderedProbes, metadataFileIds };
        }
        if (pkgRes.outcome === 'RESOLVED') {
          return { ...pkgRes, orderedProbes, metadataFileIds };
        }
        // First present field failed to resolve -> NO fallback!
        return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
      }

      // Index files
      for (const ext of ['.ts', '.tsx', '.d.ts']) {
        const p = `${candidateBase}/index${ext}`;
        if (probe(p)) {
          return { outcome: 'RESOLVED', selectedTargetOrNull: p, orderedProbes, metadataFileIds };
        }
      }

      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
    }

    // 3. Non-relative (package) imports
    if (specifier.startsWith('#')) {
      return {
        outcome: 'UNSUPPORTED',
        selectedTargetOrNull: null,
        orderedProbes,
        metadataFileIds,
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: 'Conditional package imports (#) unsupported'
      };
    }

    let pkgName: string;
    let subpath: string;

    if (specifier.startsWith('@')) {
      const parts = specifier.split('/');
      if (parts.length < 2 || !parts[1]) {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          orderedProbes,
          metadataFileIds,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: 'Malformed scoped package specifier: ' + specifier
        };
      }
      pkgName = `${parts[0]}/${parts[1]}`;
      subpath = parts.slice(2).join('/');
    } else {
      const parts = specifier.split('/');
      if (!parts[0]) {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          orderedProbes,
          metadataFileIds,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: 'Empty package name in specifier: ' + specifier
        };
      }
      pkgName = parts[0];
      subpath = parts.slice(1).join('/');
    }

    let normSubpath = '';
    if (subpath) {
      if (specifier.endsWith('/') || specifier.includes('//') || subpath.startsWith('/')) {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          orderedProbes,
          metadataFileIds,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: 'Invalid package subpath format: ' + specifier
        };
      }
      normSubpath = normalizePath(subpath);
      if (!normSubpath || normSubpath === '.' || normSubpath.startsWith('..')) {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          orderedProbes,
          metadataFileIds,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: 'Package subpath escapes package root: ' + specifier
        };
      }
    }

    // Search node_modules hierarchy
    let currentDir = dirnamePath(containingFile);
    while (true) {
      const candidateDir = currentDir ? `${currentDir}/node_modules/${pkgName}` : `node_modules/${pkgName}`;
      const pkgJsonPath = `${candidateDir}/package.json`;

      if (subpath) {
        const candidateTarget = joinPath(candidateDir, normSubpath);
        if (!candidateTarget || !candidateTarget.startsWith(candidateDir + '/')) {
          return {
            outcome: 'UNSUPPORTED',
            selectedTargetOrNull: null,
            orderedProbes,
            metadataFileIds,
            blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
            blockerMessage: 'Package subpath escapes package root: ' + specifier
          };
        }

        if (probe(pkgJsonPath)) {
          metadataFileIds.push(pkgJsonPath);
          const metaCheck = this.validatePackageMetadata(pkgJsonPath);
          if (metaCheck.blockerCode) {
            return {
              outcome: 'UNSUPPORTED',
              selectedTargetOrNull: null,
              orderedProbes,
              metadataFileIds,
              blockerCode: metaCheck.blockerCode,
              blockerMessage: metaCheck.blockerMessage
            };
          }

          const subRes = this.resolveSubpathTarget(candidateTarget, probe, metadataFileIds);
          if (subRes.blockerCode) {
            return { ...subRes, orderedProbes, metadataFileIds };
          }
          if (subRes.outcome === 'RESOLVED') {
            return { ...subRes, orderedProbes, metadataFileIds };
          }
          // Package root found, but subpath failed to resolve -> NO fallback to other node_modules!
          return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
        }

        // No package.json at candidateDir, probe subpath target directly
        const subRes = this.resolveSubpathTarget(candidateTarget, probe, metadataFileIds);
        if (subRes.blockerCode) {
          return { ...subRes, orderedProbes, metadataFileIds };
        }
        if (subRes.outcome === 'RESOLVED') {
          return { ...subRes, orderedProbes, metadataFileIds };
        }
      } else {
        // Bare package root resolution
        if (probe(pkgJsonPath)) {
          metadataFileIds.push(pkgJsonPath);
          const pkgRes = this.resolvePackageJson(pkgJsonPath, candidateDir, probe);
          if (pkgRes.blockerCode) {
            return { ...pkgRes, orderedProbes, metadataFileIds };
          }
          if (pkgRes.outcome === 'RESOLVED') {
            return { ...pkgRes, orderedProbes, metadataFileIds };
          }
          // First present field failed to resolve -> NO fallback to lower fields or other node_modules!
          return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
        }

        // No package.json, probe index files in directory
        for (const ext of ['.ts', '.tsx', '.d.ts']) {
          const p = `${candidateDir}/index${ext}`;
          if (probe(p)) {
            return { outcome: 'RESOLVED', selectedTargetOrNull: p, orderedProbes, metadataFileIds };
          }
        }
      }

      if (!currentDir) break;
      const nextDir = dirnamePath(currentDir);
      if (nextDir === currentDir) break;
      currentDir = nextDir;
    }

    return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes, metadataFileIds };
  }

  private validatePackageMetadata(
    pkgJsonPath: string
  ): { blockerCode?: BlockerCode; blockerMessage?: string; pkgJson?: any } {
    let pkgJsonRaw: Buffer;
    try {
      pkgJsonRaw = this.sealedFs.readBytes(pkgJsonPath);
    } catch {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `Missing package metadata bytes for ${pkgJsonPath}`
      };
    }

    let pkgJson: any;
    try {
      pkgJson = JSON.parse(pkgJsonRaw.toString('utf8'));
    } catch {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `Malformed package metadata in ${pkgJsonPath}`
      };
    }

    if (!pkgJson || typeof pkgJson !== 'object' || Array.isArray(pkgJson)) {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `Malformed package metadata root in ${pkgJsonPath}`
      };
    }

    // Reject unsupported fields
    if ('exports' in pkgJson) {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `Conditional exports unsupported in ${pkgJsonPath}`
      };
    }
    if ('imports' in pkgJson) {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `Conditional imports unsupported in ${pkgJsonPath}`
      };
    }
    if ('typesVersions' in pkgJson) {
      return {
        blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
        blockerMessage: `typesVersions unsupported in ${pkgJsonPath}`
      };
    }

    return { pkgJson };
  }

  private nearestTsconfig(containingFile: string): string | null {
    let directory = dirnamePath(containingFile);
    while (true) {
      const candidate = directory ? `${directory}/tsconfig.json` : 'tsconfig.json';
      if (this.sealedFs.exists(candidate)) return candidate;
      if (!directory) return null;
      directory = dirnamePath(directory);
    }
  }

  private resolveSealedPaths(
    specifier: string,
    configPath: string,
    probe: (path: string) => boolean,
    metadataFileIds: string[]
  ): ResolutionResult | undefined {
    let config: any;
    metadataFileIds.push(configPath);
    try { config = JSON.parse(this.sealedFs.readBytes(configPath).toString('utf8')); }
    catch { return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `Malformed sealed tsconfig: ${configPath}` }; }
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.extends) {
      return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `tsconfig extends/shape is unsupported: ${configPath}` };
    }
    const options = config.compilerOptions;
    if (!options || typeof options !== 'object' || !options.paths) return undefined;
    if (typeof options.baseUrl !== 'string' && options.baseUrl !== undefined) {
      return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `tsconfig baseUrl must be a string: ${configPath}` };
    }
    const matches: Array<{ pattern: string; target: string; suffix: string }> = [];
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string' || (pattern.match(/\*/g) ?? []).length > 1 || ((targets[0] as string).match(/\*/g) ?? []).length > 1) {
        return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `Only one-target, single-star paths rules are admitted: ${configPath}` };
      }
      const star = pattern.indexOf('*');
      if (star < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))) {
        const suffix = star < 0 ? '' : specifier.slice(star, specifier.length - pattern.slice(star + 1).length);
        matches.push({ pattern, target: targets[0] as string, suffix });
      }
    }
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) return { outcome: 'AMBIGUOUS', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `Ambiguous paths match for ${specifier}` };
    const replacement = matches[0].target.replace('*', matches[0].suffix);
    if (replacement.startsWith('/') || replacement.includes('..')) return { outcome: 'UNSUPPORTED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds, blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION, blockerMessage: `paths target escapes sealed project: ${replacement}` };
    const base = joinPath(dirnamePath(configPath), options.baseUrl ?? '', replacement);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`]) {
      if (probe(candidate)) return { outcome: 'RESOLVED', selectedTargetOrNull: candidate, orderedProbes: [], metadataFileIds };
    }
    return { outcome: 'UNRESOLVED', selectedTargetOrNull: null, orderedProbes: [], metadataFileIds };
  }

  private resolveSubpathTarget(
    targetBase: string,
    probe: (p: string) => boolean,
    metadataFileIds: string[]
  ): { outcome: 'RESOLVED' | 'UNRESOLVED' | 'UNSUPPORTED'; selectedTargetOrNull: string | null; blockerCode?: BlockerCode; blockerMessage?: string } {
    if (targetBase.endsWith('.ts') || targetBase.endsWith('.tsx') || targetBase.endsWith('.d.ts')) {
      if (probe(targetBase)) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: targetBase };
      }
      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
    }

    // Check file extensions in order: .ts, .tsx, .d.ts
    for (const ext of ['.ts', '.tsx', '.d.ts']) {
      const p = `${targetBase}${ext}`;
      if (probe(p)) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: p };
      }
    }

    // Check directory resolution with subdirectory package.json
    const subPkgJsonPath = `${targetBase}/package.json`;
    if (probe(subPkgJsonPath)) {
      metadataFileIds.push(subPkgJsonPath);
      const pkgRes = this.resolvePackageJson(subPkgJsonPath, targetBase, probe);
      if (pkgRes.blockerCode) {
        return pkgRes;
      }
      if (pkgRes.outcome === 'RESOLVED') {
        return pkgRes;
      }
      // First present field failed to resolve -> NO fallback!
      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
    }

    // Check directory index files in order: .ts, .tsx, .d.ts
    for (const ext of ['.ts', '.tsx', '.d.ts']) {
      const p = `${targetBase}/index${ext}`;
      if (probe(p)) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: p };
      }
    }

    return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
  }

  private resolvePackageJson(
    pkgJsonPath: string,
    pkgDir: string,
    probe: (p: string) => boolean
  ): { outcome: 'RESOLVED' | 'UNRESOLVED' | 'UNSUPPORTED'; selectedTargetOrNull: string | null; blockerCode?: BlockerCode; blockerMessage?: string } {
    const metaCheck = this.validatePackageMetadata(pkgJsonPath);
    if (metaCheck.blockerCode) {
      return {
        outcome: 'UNSUPPORTED',
        selectedTargetOrNull: null,
        blockerCode: metaCheck.blockerCode,
        blockerMessage: metaCheck.blockerMessage
      };
    }
    const pkgJson = metaCheck.pkgJson;

    const probeFileTarget = (baseTarget: string): string | null => {
      if (probe(baseTarget)) return baseTarget;
      for (const ext of ['.d.ts', '.ts', '.tsx']) {
        const p = `${baseTarget}${ext}`;
        if (probe(p)) return p;
      }
      for (const ext of ['.d.ts', '.ts', '.tsx']) {
        const p = `${baseTarget}/index${ext}`;
        if (probe(p)) return p;
      }
      return null;
    };

    // Exact precedence: types -> typings -> main
    // First present field determines target; NO fallback if it fails!
    if ('types' in pkgJson) {
      if (typeof pkgJson.types !== 'string') {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: `Malformed types field in ${pkgJsonPath}`
        };
      }
      const target = joinPath(pkgDir, pkgJson.types);
      const resolved = probeFileTarget(target);
      if (resolved) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: resolved };
      }
      // NO fallback to typings or main!
      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
    }

    if ('typings' in pkgJson) {
      if (typeof pkgJson.typings !== 'string') {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: `Malformed typings field in ${pkgJsonPath}`
        };
      }
      const target = joinPath(pkgDir, pkgJson.typings);
      const resolved = probeFileTarget(target);
      if (resolved) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: resolved };
      }
      // NO fallback to main!
      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
    }

    if ('main' in pkgJson) {
      if (typeof pkgJson.main !== 'string') {
        return {
          outcome: 'UNSUPPORTED',
          selectedTargetOrNull: null,
          blockerCode: BlockerCode.UNSUPPORTED_CONFIGURATION,
          blockerMessage: `Malformed main field in ${pkgJsonPath}`
        };
      }
      const target = joinPath(pkgDir, pkgJson.main);
      const resolved = probeFileTarget(target);
      if (resolved) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: resolved };
      }
      // NO fallback!
      return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
    }

    // Default to index files
    for (const ext of ['.ts', '.tsx', '.d.ts']) {
      const p = `${pkgDir}/index${ext}`;
      if (probe(p)) {
        return { outcome: 'RESOLVED', selectedTargetOrNull: p };
      }
    }

    return { outcome: 'UNRESOLVED', selectedTargetOrNull: null };
  }

  /**
   * Independently verifies a ResolutionFact against the sealed filesystem.
   * Replays the probe sequence and validates exact outcome and target existence.
   */
  public verifyFact(fact: ResolutionFact): VerificationResult {
    this.budget?.allocate('WORK_UNITS', 1);

    if (fact.resolverProfileId !== ResolverProfileId.F0_NODE10_STATIC_V1) {
      return this.reject(
        BlockerCode.UNSUPPORTED_CONFIGURATION,
        `Unsupported resolver profile: ${fact.resolverProfileId}`
      );
    }

    const requestObj = fact.request as { payload?: unknown };
    const payload = requestObj?.payload as { specifier?: unknown; containingFile?: unknown; compilerOptions?: unknown } | undefined;
    if (!payload || typeof payload !== 'object' || typeof payload.specifier !== 'string' || typeof payload.containingFile !== 'string') {
      return this.reject(
        BlockerCode.UNSUPPORTED_CONFIGURATION,
        'Invalid resolution request payload in ResolutionFact'
      );
    }

    const independentRes = this.resolve(
      payload.specifier,
      payload.containingFile,
      payload.compilerOptions
    );

    if (independentRes.outcome === 'UNSUPPORTED') {
      return this.reject(
        independentRes.blockerCode || BlockerCode.UNSUPPORTED_CONFIGURATION,
        independentRes.blockerMessage || 'Unsupported configuration encountered in resolution'
      );
    }

    // 1. Verify probes strictly against the sealed filesystem
    for (const p of fact.orderedProbes) {
      this.budget?.allocate('WORK_UNITS', 1);
      const actualExists = this.sealedFs.exists(p.logicalPath);
      if (actualExists !== p.exists) {
        return this.reject(
          BlockerCode.MISSING_EVIDENCE,
          `Probe existence mismatch for ${p.logicalPath}. Claimed: ${p.exists}, Actual: ${actualExists}`
        );
      }
    }

    // 2. Verify probe sequence matches independent derivation
    if (fact.orderedProbes.length !== independentRes.orderedProbes.length) {
      return this.reject(
        BlockerCode.HASH_MISMATCH,
        `Probe sequence count mismatch. Claimed: ${fact.orderedProbes.length}, Independent: ${independentRes.orderedProbes.length}`
      );
    }

    for (let i = 0; i < fact.orderedProbes.length; i++) {
      if (fact.orderedProbes[i].logicalPath !== independentRes.orderedProbes[i].logicalPath ||
          fact.orderedProbes[i].exists !== independentRes.orderedProbes[i].exists) {
        return this.reject(
          BlockerCode.HASH_MISMATCH,
          `Probe mismatch at step ${i}: Claimed ${fact.orderedProbes[i].logicalPath} (${fact.orderedProbes[i].exists}), Independent: ${independentRes.orderedProbes[i].logicalPath} (${independentRes.orderedProbes[i].exists})`
        );
      }
    }

    // 3. Verify metadata files consulted
    if (fact.metadataFileIds.length !== independentRes.metadataFileIds.length) {
      return this.reject(
        BlockerCode.HASH_MISMATCH,
        `Metadata files count mismatch. Claimed: ${fact.metadataFileIds.length}, Independent: ${independentRes.metadataFileIds.length}`
      );
    }
    for (let i = 0; i < fact.metadataFileIds.length; i++) {
      if (fact.metadataFileIds[i] !== independentRes.metadataFileIds[i]) {
        return this.reject(
          BlockerCode.HASH_MISMATCH,
          `Metadata file mismatch at ${i}: Claimed: ${fact.metadataFileIds[i]}, Independent: ${independentRes.metadataFileIds[i]}`
        );
      }
    }

    // 4. Verify outcome
    if (fact.outcome !== independentRes.outcome) {
      return this.reject(
        BlockerCode.HASH_MISMATCH,
        `Resolution outcome mismatch. Claimed: ${fact.outcome}, Independent: ${independentRes.outcome}`
      );
    }

    // 5. Verify selected target
    if (fact.selectedTargetOrNull !== independentRes.selectedTargetOrNull) {
      return this.reject(
        BlockerCode.HASH_MISMATCH,
        `Selected target mismatch. Claimed: ${fact.selectedTargetOrNull}, Independent: ${independentRes.selectedTargetOrNull}`
      );
    }

    if (fact.selectedTargetOrNull) {
      if (!this.sealedFs.exists(fact.selectedTargetOrNull)) {
        return this.reject(
          BlockerCode.RESOLUTION_TARGET_UNPROVEN,
          `Selected target missing in sealed fs: ${fact.selectedTargetOrNull}`
        );
      }
    }

    return {
      status: 'VERIFIED',
      bundleDigest: '',
      verifiedClaim: 'RESOLVED',
      verifiedAuthorityInputDigest: '',
      replayProfileId: ResolverProfileId.F0_NODE10_STATIC_V1
    };
  }

  private reject(code: BlockerCode, message: string): VerificationResult {
    return {
      status: 'REJECTED',
      blockerCode: code,
      detail: { code, message }
    };
  }
}
