/**
 * Ambient type declarations for third-party packages in packages/*
 */

declare module 'dotenv' {
  export interface DotenvConfigOptions {
    path?: string;
    encoding?: string;
    debug?: boolean;
    override?: boolean;
  }
  export interface DotenvConfigOutput {
    error?: Error;
    parsed?: Record<string, string>;
  }
  export function config(options?: DotenvConfigOptions): DotenvConfigOutput;
}


declare module '@huggingface/transformers' {
  export const pipeline: any;
  export const env: any;
}

declare module '@pinecone-database/pinecone' {
  export class Pinecone {
    constructor(options?: any);
    index(name: string): any;
    describeIndex(name: string): Promise<any>;
    [key: string]: any;
  }
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; readOnly?: boolean; enableForeignKeyConstraints?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export interface StatementSync {
    all(...namedParameters: any[]): any[];
    get(...namedParameters: any[]): any;
    run(...namedParameters: any[]): { changes: number; lastInsertRowid: number | bigint };
  }
}
