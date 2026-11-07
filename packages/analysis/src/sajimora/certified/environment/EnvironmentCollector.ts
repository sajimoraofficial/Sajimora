import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import { 
  EnvironmentManifest, 
  FileEntry, 
  ProjectEntry, 
  PackageEntry, 
  AmbientRoot,
  Vertex
} from '../../../../../core/src/sajimora/certified/contracts';
import { CanonicalSet, computeDomainSeparatedHash } from '../../../../../core/src/sajimora/certified/canonicalEncoding';
import { 
  RootPolicyId, 
  ArtifactDomain,
  SAJIMORA_CERTIFIED_EVIDENCE_V1
} from '../../../../../core/src/sajimora/certified/protocol';

export interface CollectionResult {
  manifest: EnvironmentManifest;
  dataEntries: { digest: string; data: Buffer }[];
}

export class EnvironmentCollector {
  constructor(
    private readonly repositoryRoot: string,
    private readonly commitId: string
  ) {}

  public collect(
    filePaths: string[], 
    projectEntries: ProjectEntry[],
    packageEntries: PackageEntry[],
    ambientRoots: AmbientRoot[]
  ): CollectionResult {
    
    const files: FileEntry[] = [];
    const dataEntries: { digest: string; data: Buffer }[] = [];

    for (const logicalPath of filePaths) {
      const fullPath = path.join(this.repositoryRoot, logicalPath);
      
      let data: Buffer;
      try {
        data = fs.readFileSync(fullPath);
      } catch (e) {
        throw new Error(`Failed to collect required file: ${logicalPath}`);
      }

      const hash = computeDomainSeparatedHash(ArtifactDomain.SOURCE_BYTES, SAJIMORA_CERTIFIED_EVIDENCE_V1, data);
      
      files.push({
        fileId: logicalPath,
        logicalPath: logicalPath,
        byteLength: data.length,
        bytesRef: { domain: ArtifactDomain.SOURCE_BYTES, digest: hash },
        mode: 0o644, // In a real impl, this comes from Git tree
        kind: 'SOURCE', // simplified for now
        origin: 'GIT_OBJECT',
        provenanceRefs: []
      });

      dataEntries.push({ digest: hash, data });
    }

    // Bind revision metadata to the exact collected bytes and compiler profile.
    // These values are deterministic for a given sealed input and avoid the
    // placeholder metadata that could not be verified downstream.
    const treeId = crypto.createHash('sha256')
      .update(files.map(file => `${file.logicalPath}\0${file.bytesRef.digest}`).sort().join('\n'))
      .digest('hex');
    const compilerVersion = '5.9.3';
    const parserProfile = 'TS_5_9_3_STRICT';
    const semanticProfile = 'TS_FINITE_CONTRACTS_F0';
    const distributionDigest = crypto.createHash('sha256')
      .update(`${compilerVersion}\0${parserProfile}\0${semanticProfile}`)
      .digest('hex');

    const manifest: EnvironmentManifest = {
      schemaVersion: SAJIMORA_CERTIFIED_EVIDENCE_V1,
      repositoryId: 'local-repo',
      revision: {
        commitId: this.commitId,
        treeId,
        parentSelection: 'NONE'
      },
      environmentBasis: 'RECORDED_BUILD',
      historicalBindingEvidenceRefs: [],
      namespace: {
        pathPolicyId: 'POSIX',
        caseSensitivity: 'SENSITIVE',
        unicodePolicy: 'NFC',
        files: files,
        symlinks: [],
        directoryInventory: [],
        completenessEvidenceRefs: new CanonicalSet()
      },
      compiler: {
        packageVersion: '5.9.3',
        distributionDigest,
        parserProfileId: parserProfile,
        semanticProfileId: semanticProfile
      },
      projects: projectEntries,
      packages: packageEntries,
      rootSelectionPolicyId: RootPolicyId.F0_ENV_GIT_SEALED_V1,
      admittedRoots: new CanonicalSet<Vertex>(),
      ambientRoots: new CanonicalSet<AmbientRoot>(ambientRoots),
      generatedArtifacts: new CanonicalSet(),
      boundaryPolicyId: 'F0_STRICT_BOUNDARY_V1',
      inputEvidenceRefs: new CanonicalSet()
    };

    return { manifest, dataEntries };
  }
}
