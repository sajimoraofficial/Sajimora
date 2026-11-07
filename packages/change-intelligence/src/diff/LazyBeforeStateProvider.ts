/**
 * SAJIMORA V32 — Lazy BEFORE State Acquisition Provider
 * Subordinate to sajimora_v32_foundation_spec.md §2.4 & Resolved Decision OQ-1.
 *
 * Implements lazy, on-demand BEFORE state retrieval:
 * 1. Checks active GraphVersion in V31 GraphStorageProvider if available.
 * 2. Falls back to repositoryProvider.getFileContentAtRevision() and calls IAstExtractor.
 * 3. Maintains an execution-scoped in-memory parse cache (no persistent cache).
 *
 * VCS-Agnostic: relies on IRepositoryStateProvider abstraction (defaulting to Git).
 */

import * as path from 'path';
import * as fs from 'fs';
import { IRepositoryStateProvider } from './RepositoryStateProvider';
import { GitChangeSetFilter, IGitRunner } from './GitChangeSetFilter';

export interface FunctionSymbol {
  name: string;
  signature?: string;
  parameters?: string[];
  returnType?: string;
  startLine?: number;
  endLine?: number;
}

export interface ClassSymbol {
  name: string;
  methods?: FunctionSymbol[];
  properties?: string[];
  interfaces?: string[];
}

export interface ParseResult {
  filePath: string;
  functions?: FunctionSymbol[];
  classes?: ClassSymbol[];
  imports?: string[];
  exports?: string[];
  endpoints?: { route: string; method: string }[];
  databaseModels?: string[];
  commentsSanitized?: boolean;
  parserType?: 'native' | 'fallback';
  completeness?: 'full' | 'partial';
  error?: string;
}

export interface IAstExtractor {
  parseFile(filePath: string, content: string): Promise<ParseResult>;
}

export interface IBeforeStateProvider {
  getBeforeParseResult(
    workspaceId: string,
    baseRevision: string,
    filePath: string
  ): Promise<ParseResult | null>;
  getAfterParseResult(
    filePath: string,
    candidateRevision?: string
  ): Promise<ParseResult | null>;
  clearCache?(): void;
}

export class DefaultAstExtractor implements IAstExtractor {
  private delegate: any = null;

  constructor(delegate?: any) {
    this.delegate = delegate || null;
  }

  async parseFile(filePath: string, content: string): Promise<ParseResult> {
    if (this.delegate && typeof this.delegate.parseFile === 'function') {
      try {
        return await this.delegate.parseFile(filePath, content);
      } catch {
        // Fall back to built-in deterministic parser
      }
    }
    return this.fallbackParse(filePath, content);
  }

  private fallbackParse(filePath: string, content: string): ParseResult {
    const functions: FunctionSymbol[] = [];
    const classes: ClassSymbol[] = [];
    const imports: string[] = [];
    const exports: string[] = [];

    const lines = content.split(/\r?\n/);
    lines.forEach((line: string, idx: number) => {
      const lineNum = idx + 1;
      // Match functions: function foo(...), async function bar(...)
      const fnMatch = line.match(/(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/);
      if (fnMatch) {
        functions.push({
          name: fnMatch[1],
          signature: `${fnMatch[1]}(${fnMatch[2].trim()})`,
          parameters: fnMatch[2].split(',').map((p) => p.trim()).filter(Boolean),
          returnType: 'any',
          startLine: lineNum,
          endLine: lineNum,
        });
      }

      // Match classes
      const clsMatch = line.match(/class\s+([a-zA-Z0-9_$]+)/);
      if (clsMatch) {
        classes.push({
          name: clsMatch[1],
          methods: [],
          properties: [],
          interfaces: [],
        });
      }

      // Match class methods if inside a class
      const methodMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|async\s+)*([a-zA-Z0-9_$]+)\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*\{/);
      if (
        methodMatch &&
        classes.length > 0 &&
        !line.includes('function ') &&
        !line.includes('class ') &&
        !line.includes('if ') &&
        !line.includes('for ') &&
        !line.includes('while ') &&
        !line.includes('switch ')
      ) {
        const methodName = methodMatch[1];
        const currentClass = classes[classes.length - 1];
        if (currentClass) {
          if (!currentClass.methods) {
            currentClass.methods = [];
          }
          currentClass.methods.push({
            name: methodName,
            signature: `${methodName}(${methodMatch[2].trim()})`,
            parameters: methodMatch[2].split(',').map((p) => p.trim()).filter(Boolean),
            returnType: methodMatch[3] ? methodMatch[3].trim() : 'any',
            startLine: lineNum,
            endLine: lineNum,
          });
        }
      }

      // Match imports
      if (line.match(/^\s*import\s+/)) {
        imports.push(line.trim());
      }

      // Match exports
      if (line.match(/^\s*export\s+/)) {
        exports.push(line.trim());
      }
    });

    return {
      filePath,
      functions,
      classes,
      imports,
      exports,
      parserType: 'fallback',
      completeness: 'full',
    };
  }
}

export interface BeforeStateProviderOptions {
  graphStorageProvider?: any;
  astExtractor?: IAstExtractor;
  repositoryProvider?: IRepositoryStateProvider;
  customGit?: IGitRunner;
}

export class LazyBeforeStateProvider implements IBeforeStateProvider {
  private workspaceRoot: string;
  private repositoryProvider: IRepositoryStateProvider;
  private astExtractor: IAstExtractor;
  private graphStorageProvider?: any;
  private parseCache: Map<string, ParseResult> = new Map();

  constructor(workspaceRoot: string, options: BeforeStateProviderOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.astExtractor = options.astExtractor || new DefaultAstExtractor();
    this.graphStorageProvider = options.graphStorageProvider;

    if (options.repositoryProvider) {
      this.repositoryProvider = options.repositoryProvider;
    } else {
      this.repositoryProvider = new GitChangeSetFilter(this.workspaceRoot, options.customGit);
    }
  }

  /** Clears the execution-scoped in-memory parse cache. */
  clearCache(): void {
    this.parseCache.clear();
  }

  /**
   * Retrieves the ParseResult for a given file at baseRevision.
   */
  async getBeforeParseResult(
    workspaceId: string,
    baseRevision: string,
    filePath: string
  ): Promise<ParseResult | null> {
    const cacheKey = `${baseRevision}:${filePath}`;
    if (this.parseCache.has(cacheKey)) {
      return this.parseCache.get(cacheKey)!;
    }

    // 1. Check GraphStorageProvider if active GraphVersion matches baseRevision
    if (this.graphStorageProvider) {
      try {
        const activeVersion = await this.graphStorageProvider.getActiveGraphVersion(workspaceId);
        if (activeVersion && activeVersion.commitSha === baseRevision) {
          const node = await this.graphStorageProvider.findNodeByPath(workspaceId, filePath, 'FILE');
          if (node && node.metadata && node.metadata.parseResult) {
            const res = node.metadata.parseResult as ParseResult;
            this.parseCache.set(cacheKey, res);
            return res;
          }
        }
      } catch {
        // Fall back to repository provider on any storage error
      }
    }

    // 2. Fallback: historical file content from repository provider
    try {
      const fileContent = await this.repositoryProvider.getFileContentAtRevision(baseRevision, filePath);

      if (typeof fileContent === 'string') {
        const res = await this.astExtractor.parseFile(filePath, fileContent);
        this.parseCache.set(cacheKey, res);
        return res;
      }
    } catch {
      // File may not exist in base revision (e.g. newly added file)
      return null;
    }

    return null;
  }

  /**
   * Retrieves the ParseResult for a given file in AFTER state (workspace filesystem or candidate revision).
   */
  async getAfterParseResult(
    filePath: string,
    candidateRevision?: string
  ): Promise<ParseResult | null> {
    // If candidateRevision is provided and repositoryProvider supports candidate content:
    if (candidateRevision && this.repositoryProvider.getCandidateFileContent) {
      try {
        const fileContent = await this.repositoryProvider.getCandidateFileContent(candidateRevision, filePath);
        if (typeof fileContent === 'string') {
          return await this.astExtractor.parseFile(filePath, fileContent);
        }
        return null;
      } catch {
        // Revision read failed; do not corrupt candidate revision state with working-tree disk state
        return null;
      }
    }

    // Disk read only when working tree evaluation is requested (no candidate revision specified)
    if (!candidateRevision) {
      if (filePath.includes('\0')) return null;
      const fullPath = path.resolve(this.workspaceRoot, filePath);
      try {
        const canonicalWorkspace = fs.realpathSync.native(this.workspaceRoot);
        const canonicalFile = fs.realpathSync.native(fullPath);
        const rel = path.relative(canonicalWorkspace, canonicalFile);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return null;
        }
        const content = fs.readFileSync(canonicalFile, 'utf8');
        return await this.astExtractor.parseFile(filePath, content);
      } catch {
        return null;
      }
    }

    return null;
  }
}
