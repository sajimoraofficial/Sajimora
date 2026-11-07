import * as path from 'node:path';
import * as fs from 'node:fs';
import { SajimoraExecutionError } from './errors';
import { loadSajimoraConfig } from './config';

export interface AnalyzeArguments {
  repo: string;
  parent: string;
  candidate: string;
  language: 'auto' | 'typescript' | 'java';
  engine: 'advisory' | 'production' | 'legacy' | 'certification' | 'f0';
  format?: 'json' | 'markdown' | 'text';
  output?: string;
  frontend?: string;
  dependencyRoot?: string;
  config?: string;
  trustPolicy?: string;
  trustedLocal?: boolean;
  failOnViolation?: boolean;
  strict?: boolean;
}

const valued = new Set([
  '--repo',
  '--parent',
  '--candidate',
  '--language',
  '--engine',
  '--format',
  '--output',
  '--frontend',
  '--dependency-root',
  '--config',
  '--trust-policy'
]);

const booleanFlags = new Set([
  '--fail-on-violation',
  '--strict',
  '--trusted-local'
]);

export function discoverFrontendContract(repoDir: string, explicitPath?: string): string | undefined {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
    throw new SajimoraExecutionError(`Specified frontend contract file not found: ${explicitPath}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }
  const searchCandidates = [
    path.join(repoDir, 'frontend.json'),
    path.join(repoDir, 'frontend-artifact.json'),
    path.join(repoDir, 'artifacts', 'frontend.json'),
    path.join(repoDir, 'artifacts', 'frontend-artifact.json'),
    path.join(repoDir, 'contracts', 'frontend.json')
  ];
  for (const candidate of searchCandidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  }
  return undefined;
}

export function parseArguments(argv: string[]): AnalyzeArguments {
  const cleanArgv: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && (arg === 'analyze' || arg === 'sajimora:analyze')) {
      continue;
    }
    if (i === 0 && arg === 'sajimora' && argv[1] === 'analyze') {
      i++;
      continue;
    }
    cleanArgv.push(arg);
  }

  const values = new Map<string, string>();
  const activeBooleans = new Set<string>();
  for (let i = 0; i < cleanArgv.length; i++) {
    const flag = cleanArgv[i];
    if (booleanFlags.has(flag)) {
      if (activeBooleans.has(flag)) throw new SajimoraExecutionError(`Duplicate argument: ${flag}`, 2, 'ANALYSIS_INPUT_FAILURE');
      activeBooleans.add(flag);
      continue;
    }
    if (!valued.has(flag)) throw new SajimoraExecutionError(`Unknown argument: ${flag}`, 2, 'ANALYSIS_INPUT_FAILURE');
    if (values.has(flag)) throw new SajimoraExecutionError(`Duplicate argument: ${flag}`, 2, 'ANALYSIS_INPUT_FAILURE');
    const value = cleanArgv[++i];
    if (!value || value.startsWith('--')) throw new SajimoraExecutionError(`Missing value for ${flag}`, 2, 'ANALYSIS_INPUT_FAILURE');
    values.set(flag, value);
  }

  const repo = values.has('--repo') ? path.resolve(values.get('--repo')!) : process.cwd();
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw new SajimoraExecutionError(`Invalid repository directory: ${repo}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }

  const candidate = values.get('--candidate') ?? 'HEAD';
  const parent = values.get('--parent') ?? 'HEAD~1';

  const rawLang = values.get('--language') ?? 'auto';
  if (rawLang !== 'auto' && rawLang !== 'typescript' && rawLang !== 'java') {
    throw new SajimoraExecutionError(`Invalid language: ${rawLang}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }
  const language = rawLang as 'auto' | 'typescript' | 'java';

  const rawEngine = values.get('--engine') ?? 'advisory';
  if (!['advisory', 'production', 'legacy', 'certification', 'f0'].includes(rawEngine)) {
    throw new SajimoraExecutionError(`Invalid engine: ${rawEngine}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }
  const engine = rawEngine as AnalyzeArguments['engine'];

  const rawFormat = values.get('--format') ?? 'json';
  if (rawFormat !== 'json' && rawFormat !== 'markdown' && rawFormat !== 'text') {
    throw new SajimoraExecutionError(`Invalid format: ${rawFormat}`, 2, 'ANALYSIS_INPUT_FAILURE');
  }
  const format = rawFormat as 'json' | 'markdown' | 'text';

  const outputValue = values.get('--output');
  const output = outputValue ? path.resolve(outputValue) : undefined;
  if (output && (!fs.existsSync(path.dirname(output)) || (fs.existsSync(output) && fs.statSync(output).isDirectory()))) {
    throw new SajimoraExecutionError('Invalid output destination.', 2, 'ANALYSIS_INPUT_FAILURE');
  }
  const dependencyRoot = values.get('--dependency-root') ? path.resolve(values.get('--dependency-root')!) : undefined;
  if (dependencyRoot && (!fs.existsSync(path.join(dependencyRoot, 'node_modules')) || !fs.statSync(path.join(dependencyRoot, 'node_modules')).isDirectory())) {
    throw new SajimoraExecutionError('Dependency root must contain node_modules.', 2, 'ANALYSIS_INPUT_FAILURE');
  }

  const configFlag = values.get('--config');
  let configFrontend: string | undefined;
  if (configFlag || fs.existsSync(path.join(repo, 'sajimora.config.json'))) {
    try {
      const cfg = loadSajimoraConfig(repo, configFlag);
      if (cfg?.contracts?.frontend) {
        configFrontend = path.resolve(repo, cfg.contracts.frontend);
      }
    } catch (err) {
      throw new SajimoraExecutionError((err as Error).message, 2, 'ANALYSIS_INPUT_FAILURE');
    }
  }

  const frontend = discoverFrontendContract(repo, values.get('--frontend') ?? configFrontend);

  const trustPolicy = values.get('--trust-policy');
  const trustedLocal = activeBooleans.has('--trusted-local');
  if (trustedLocal && trustPolicy) {
    throw new SajimoraExecutionError('Choose --trust-policy or --trusted-local, not both.', 2, 'ANALYSIS_INPUT_FAILURE');
  }

  const failOnViolation = activeBooleans.has('--fail-on-violation') || activeBooleans.has('--strict');
  const strict = activeBooleans.has('--strict');

  return {
    repo,
    parent,
    candidate,
    language,
    engine,
    format,
    ...(output ? { output } : {}),
    ...(frontend ? { frontend } : {}),
    ...(dependencyRoot ? { dependencyRoot } : {}),
    ...(configFlag ? { config: configFlag } : {}),
    ...(trustPolicy ? { trustPolicy: path.resolve(trustPolicy) } : {}),
    ...(trustedLocal ? { trustedLocal: true } : {}),
    ...(failOnViolation ? { failOnViolation: true } : {}),
    ...(strict ? { strict: true } : {})
  };
}
