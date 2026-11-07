/**
 * Experimental pipeline switches.
 *
 * The default is deliberately conservative: experimental admission behavior
 * must never be enabled implicitly by callers or by production evaluation.
 */
export interface PipelineFeatureFlags {
  readonly ENABLE_TARGET_SCOPED_ADMISSION: boolean;
}

export const DEFAULT_PIPELINE_FLAGS: PipelineFeatureFlags = Object.freeze({
  ENABLE_TARGET_SCOPED_ADMISSION: false
});

export function normalizePipelineFeatureFlags(
  flags?: Partial<PipelineFeatureFlags>
): PipelineFeatureFlags {
  return Object.freeze({
    ...DEFAULT_PIPELINE_FLAGS,
    ...(flags ?? {})
  });
}
