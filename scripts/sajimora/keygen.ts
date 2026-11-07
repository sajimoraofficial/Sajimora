import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommandIO } from './command';
import { ArtifactTrustPolicy } from '../../packages/analysis/src/sajimora/cross-language/ArtifactAdmission';

export interface KeygenOptions {
  outDir?: string;
  keyId?: string;
  repoId?: string;
  serviceId?: string;
}

export function parseKeygenArgs(argv: string[]): KeygenOptions {
  const options: KeygenOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--out-dir' || arg === '-o') && argv[i + 1]) {
      options.outDir = argv[++i];
    } else if (arg === '--key-id' && argv[i + 1]) {
      options.keyId = argv[++i];
    } else if (arg === '--repo-id' && argv[i + 1]) {
      options.repoId = argv[++i];
    } else if (arg === '--service-id' && argv[i + 1]) {
      options.serviceId = argv[++i];
    }
  }
  return options;
}

export function runKeygenCommand(
  options: KeygenOptions = {},
  io: CommandIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }
): number {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  const repoId = options.repoId ?? 'example-org/repo';
  const serviceId = options.serviceId ?? 'frontend-service';
  const trustPolicy: ArtifactTrustPolicy = {
    producers: [
      {
        repositoryId: repoId,
        serviceId: serviceId,
        publicKeyPem: publicKey
      }
    ],
    requireSignatures: true
  };

  if (options.outDir) {
    const targetDir = path.resolve(options.outDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const privPath = path.join(targetDir, 'sajimora-private.pem');
    const pubPath = path.join(targetDir, 'sajimora-public.pem');
    const policyPath = path.join(targetDir, 'trust-policy.json');

    fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
    fs.writeFileSync(pubPath, publicKey, { mode: 0o644 });
    fs.writeFileSync(policyPath, JSON.stringify(trustPolicy, null, 2) + '\n', { mode: 0o644 });

    io.stdout(`Ed25519 keypair and trust policy generated successfully:
  - Private key:  ${privPath} (mode 0600)
  - Public key:   ${pubPath}
  - Trust policy: ${policyPath}
`);
  } else {
    io.stdout(JSON.stringify({
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      trustPolicy
    }, null, 2) + '\n');
  }

  return 0;
}
