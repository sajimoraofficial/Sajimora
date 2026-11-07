import {
  AdapterDetectionInput, AdapterSelectionResult, LanguageAnalysisAdapter
} from './types';

export class LanguageAdapterRegistry {
  private readonly adapters = new Map<string, LanguageAnalysisAdapter>();

  register(adapter: LanguageAnalysisAdapter): void {
    const id = adapter.descriptor.id;
    if (!id || !adapter.descriptor.version || this.adapters.has(id)) {
      throw new Error(`Invalid or duplicate language adapter: ${id || '<empty>'}`);
    }
    this.adapters.set(id, adapter);
  }

  select(language: 'auto' | 'typescript' | 'java', input: AdapterDetectionInput): AdapterSelectionResult {
    if (language === 'typescript') {
      const adapter = this.adapters.get('typescript-v1');
      if (!adapter) throw new Error('TypeScript adapter is not registered.');
      const support = adapter.canAnalyze(input);
      if (support.status !== 'SUPPORTED') throw new Error(support.unsupportedBoundary ?? 'TypeScript analysis is unsupported.');
      return { mode: 'explicit', adapter, evidence: support.evidence };
    }

    if (language === 'java') {
      const adapter = this.adapters.get('java-v1') ?? this.adapters.get('java');
      if (!adapter) throw new Error('Java adapter is not registered.');
      const support = adapter.canAnalyze(input);
      if (support.status !== 'SUPPORTED') throw new Error(support.unsupportedBoundary ?? 'Java analysis is unsupported.');
      return { mode: 'explicit', adapter, evidence: support.evidence };
    }

    const supported = [...this.adapters.values()]
      .map(adapter => ({ adapter, support: adapter.canAnalyze(input) }))
      .filter(entry => entry.support.status === 'SUPPORTED')
      .sort((a, b) => (a.adapter.descriptor.id < b.adapter.descriptor.id ? -1 : a.adapter.descriptor.id > b.adapter.descriptor.id ? 1 : 0));
    if (supported.length !== 1) {
      throw new Error(supported.length === 0 ? 'No supported language adapter detected.' : 'Language adapter detection is ambiguous.');
    }
    return { mode: 'auto', adapter: supported[0].adapter, evidence: supported[0].support.evidence };
  }
}
