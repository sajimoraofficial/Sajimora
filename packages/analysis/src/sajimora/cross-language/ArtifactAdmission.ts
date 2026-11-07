import { verify, createPublicKey } from 'node:crypto';
import { ContractArtifactEnvelope, verifyEnvelopeIntegrity } from './ContractArtifactEnvelope';

/** This policy must come from the caller, never from an artifact. */
export interface ArtifactTrustPolicy {
  producers: { repositoryId: string; serviceId: string; publicKeyPem?: string; trustedDigests?: string[] }[];
  requireSignatures: boolean;
}
export function admitArtifact(e: ContractArtifactEnvelope, policy: ArtifactTrustPolicy, trustedLocal: boolean = false): void {
  if (!verifyEnvelopeIntegrity(e)) throw new Error('Artifact integrity verification failed.');
  if (!policy || !Array.isArray(policy.producers) || typeof policy.requireSignatures !== 'boolean') {
    throw new Error('Invalid artifact trust policy: requireSignatures must be explicitly specified.');
  }
  const producer = policy.producers.find(p => p.repositoryId === e.snapshot.repositoryId && p.serviceId === e.snapshot.serviceId);
  if (!producer) throw new Error('Artifact producer is not authorized by trust policy.');
  // trusted_local startup decision grants authorized producer signature/digest waiver:
  if (trustedLocal) return;
  // Pinned digests attest selection by the caller, only when explicitly permitted.
  if (!policy.requireSignatures && producer.trustedDigests?.includes(e.integrity!.sha256)) return;
  if (!e.signature || !producer.publicKeyPem) throw new Error('Artifact requires an authorized signature or a trusted pinned digest.');
  const pubKey = createPublicKey(producer.publicKeyPem);
  if (pubKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Unsupported key algorithm: only ed25519 keys are authorized for artifact signatures.');
  }
  if (!verify(null, Buffer.from(e.integrity!.sha256, 'utf8'), pubKey, Buffer.from(e.signature, 'base64'))) throw new Error('Artifact signature verification failed.');
}
