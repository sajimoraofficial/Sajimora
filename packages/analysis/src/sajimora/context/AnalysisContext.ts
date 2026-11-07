import * as ts from 'typescript';
import * as path from 'path';
import { RepositoryAnalysisUniverse, isSourceInUniverse } from '@sajimora/core';

export interface AnalysisContextOptions {
  compilerHost?: ts.CompilerHost;
  compilerOptions?: ts.CompilerOptions;
  program?: ts.Program;
  programs?: ts.Program[];
}

export class AnalysisContext {
  private program: ts.Program | null = null;
  private programs: ts.Program[] = [];
  private programBySourceFile: Map<ts.SourceFile, ts.Program> = new Map();
  private checkerByProgram: Map<ts.Program, ts.TypeChecker> = new Map();
  private checker: ts.TypeChecker | null = null;
  private host: ts.CompilerHost;
  private options: ts.CompilerOptions;

  constructor(
    private universe: RepositoryAnalysisUniverse,
    options?: AnalysisContextOptions
  ) {
    const defaultOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      rootDir: this.universe.rootPath,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: false,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true
    };

    this.options = {
      ...defaultOptions,
      ...((this.universe.compilerOptions as ts.CompilerOptions | undefined) ?? {}),
      ...(options?.compilerOptions ?? {})
    };
    this.host = options?.compilerHost ?? ts.createCompilerHost(this.options);
    if (options?.program) {
      this.program = options.program;
      this.checker = options.program.getTypeChecker();
      this.programs.push(options.program);
      this.checkerByProgram.set(options.program, this.checker);
      for (const sf of options.program.getSourceFiles()) {
        this.programBySourceFile.set(sf, options.program);
      }
    }
    if (options?.programs && options.programs.length > 0) {
      for (const p of options.programs) {
        if (!this.programs.includes(p)) {
          this.programs.push(p);
        }
        for (const sf of p.getSourceFiles()) {
          this.programBySourceFile.set(sf, p);
        }
      }
      if (!this.program && this.programs.length > 0) {
        this.program = this.programs[0];
        this.checker = this.program.getTypeChecker();
        this.checkerByProgram.set(this.program, this.checker);
      }
    }
  }

  /**
   * Returns the underlying unified ts.Program.
   * Constructs the program lazily on first access if none was provided.
   */
  public getProgram(): ts.Program {
    if (!this.program) {
      this.program = ts.createProgram(
        this.universe.discoveredFiles,
        this.options,
        this.host
      );
      // TypeScript recovers from syntax errors by producing a SourceFile. Recovery
      // must not be mistaken for a parse-complete universe.
      for (const diagnostic of this.program.getSyntacticDiagnostics()) {
        if (diagnostic.file) {
          this.universe.parseFailures.set(
            diagnostic.file.fileName.replace(/\\/g, '/'),
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
          );
        }
      }
      this.checker = this.program.getTypeChecker();
      this.programs.push(this.program);
      this.checkerByProgram.set(this.program, this.checker);
      for (const sf of this.program.getSourceFiles()) {
        this.programBySourceFile.set(sf, this.program);
      }
    }
    return this.program;
  }

  /**
   * Returns the TypeChecker associated with the unified Program or a specific node/source file.
   */
  public getTypeChecker(nodeOrSourceFile?: ts.Node | ts.SourceFile): ts.TypeChecker {
    if (nodeOrSourceFile) {
      const sf = ('getSourceFile' in nodeOrSourceFile && typeof (nodeOrSourceFile as any).getSourceFile === 'function')
        ? (nodeOrSourceFile as any).getSourceFile()
        : nodeOrSourceFile as ts.SourceFile;
      if (sf) {
        const prog = this.programBySourceFile.get(sf);
        if (prog) {
          let ch = this.checkerByProgram.get(prog);
          if (!ch) {
            ch = prog.getTypeChecker();
            this.checkerByProgram.set(prog, ch);
          }
          return ch;
        }
      }
    }
    if (!this.checker) {
      this.getProgram();
    }
    return this.checker!;
  }

  /**
   * Checks whether a source file is strictly within the declared analysis universe.
   */
  public isFileInUniverse(sourcePath: string): boolean {
    const normalized = sourcePath.replace(/\\/g, '/');
    return isSourceInUniverse(this.universe, normalized);
  }

  /**
   * Retrieves a SourceFile if it exists within the analysis universe.
   */
  public getSourceFile(fileName: string): ts.SourceFile | undefined {
    const normalized = fileName.replace(/\\/g, '/');
    if (this.programs.length > 0) {
      for (const p of this.programs) {
        const sf = p.getSourceFile(normalized);
        if (sf) return sf;
      }
    }
    const program = this.getProgram();
    return program.getSourceFile(normalized);
  }

  /**
   * Returns all parsed SourceFiles that belong to the declared universe across all programs.
   */
  public getUniverseSourceFiles(): ts.SourceFile[] {
    if (this.programs.length > 0) {
      const seen = new Set<string>();
      const result: ts.SourceFile[] = [];
      for (const p of this.programs) {
        for (const sf of p.getSourceFiles()) {
          const norm = sf.fileName.replace(/\\/g, '/');
          if (!seen.has(norm) && this.isFileInUniverse(sf.fileName)) {
            seen.add(norm);
            result.push(sf);
          }
        }
      }
      return result;
    }
    const program = this.getProgram();
    return program.getSourceFiles().filter(sf => this.isFileInUniverse(sf.fileName));
  }

  /**
   * Disposes the current programs and type checkers to release compiler caches
   * and prevent linear memory accumulation.
   */
  public dispose(): void {
    this.program = null;
    this.checker = null;
    this.programs = [];
    this.programBySourceFile.clear();
    this.checkerByProgram.clear();
    if (typeof global !== 'undefined' && typeof (global as any).gc === 'function') {
      try {
        (global as any).gc();
      } catch {
        // Ignore if GC cannot be manually triggered
      }
    }
  }
}
