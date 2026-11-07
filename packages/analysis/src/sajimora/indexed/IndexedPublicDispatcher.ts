import { GenerationIndexDatabase } from './GenerationIndexDatabase';
import { IndexedQueryEngineV2, IndexedQueryV2Result } from './IndexedQueryEngineV2';

export interface IndexedDispatchRequest {
  readonly indexLocation: string;
  readonly repositoryId: string;
  readonly parentSha: string;
  readonly candidateSha: string;
}

/** Authoritative indexed dispatcher. It has no live-analysis fallback by design. */
export class IndexedPublicDispatcher {
  public dispatch(request: IndexedDispatchRequest): IndexedQueryV2Result {
    if (!request.indexLocation || !request.repositoryId || !request.parentSha || !request.candidateSha) {
      return { status: 'INDEX_INCOMPATIBLE', blockers: ['INDEXED_DISPATCH_ARGUMENTS_INCOMPLETE'] };
    }
    let database: GenerationIndexDatabase | undefined;
    try {
      database = new GenerationIndexDatabase(request.indexLocation, true);
      return new IndexedQueryEngineV2().evaluate(database, request.repositoryId, request.parentSha, request.candidateSha);
    } catch (error) {
      return { status: 'INDEX_CORRUPT', blockers: [error instanceof Error ? error.message : String(error)] };
    } finally {
      database?.close();
    }
  }
}
