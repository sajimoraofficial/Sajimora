/**
 * @file languages/java/index.ts
 * Public barrel for the Java language adapter layer.
 * Mirrors the structure of the TypeScript language barrel.
 */

export * from './JavaLanguageAdapter';
export * from './ir';
export * from './compatibility/JavaSemanticRules';
export * from './identity/JavaIdentityGate';
export * from './programs/JavaSealedCompilerHost';
export * from './programs/JavaBuildModelExtractor';
export * from './programs/JavaMultiModuleCompilerHost';
export * from './programs/JavaRepositoryQualifier';
export * from './certified';
