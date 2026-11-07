import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// Opt-in benchmark checkpoints. No source text or contract data is recorded.
export function coldCheckpoint(stage: string, facts: Record<string, unknown> = {}): void {
  const output = process.env.SAJIMORA_COLD_TELEMETRY;
  if (!output) return;
  fs.appendFileSync(output, JSON.stringify({stage, elapsedMs: performance.now(), ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, ...facts}) + '\n');
}

export function coldSourceCounts(files: ReadonlyMap<string, {bytes: Buffer}>): void {
  if (!process.env.SAJIMORA_COLD_TELEMETRY) return;
  const counts: Record<string, {files: number; bytes: number; physicalLines: number}> = {};
  for (const [name, file] of files) {
    const extension = name.match(/\.(java|ts|tsx|js|jsx)$/)?.[1];
    if (!extension) continue;
    const item = counts[extension] ??= {files: 0, bytes: 0, physicalLines: 0};
    item.files++; item.bytes += file.bytes.length;
    let lines = 0;
    for (const byte of file.bytes) if (byte === 10) lines++;
    if (file.bytes.length && file.bytes[file.bytes.length - 1] !== 10) lines++;
    item.physicalLines += lines;
  }
  coldCheckpoint('source-counts', {counts});
}
