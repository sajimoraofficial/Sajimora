export type SajimoraExitCode = 1 | 2 | 3 | 4 | 5 | 6;
export class SajimoraExecutionError extends Error {
  constructor(message: string, readonly exitCode: SajimoraExitCode, readonly category: string, options?: { cause?: unknown }) { super(message, options); this.name = 'SajimoraExecutionError'; }
}
