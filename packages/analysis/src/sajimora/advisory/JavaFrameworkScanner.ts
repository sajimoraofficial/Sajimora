/**
 * @file JavaFrameworkScanner.ts
 * Scans Java providers against framework lifecycle annotations, SPI registrations,
 * and enterprise XML descriptors to determine framework reachability (§4.4).
 */

import { JavaClassDeclIR, JavaMethodSignatureIR, JavaFieldIR } from '../languages/java/ir/JavaTypeIR';

export interface FrameworkReachabilityEvidence {
  readonly providerId: string;
  readonly reachabilityKind: 'ANNOTATION' | 'SPI_DESCRIPTOR' | 'XML_DESCRIPTOR';
  readonly descriptorFile?: string;
  readonly matchedToken: string;
}

export const FRAMEWORK_ANNOTATIONS: ReadonlySet<string> = new Set([
  'Bean',
  'EventListener',
  'Component',
  'Service',
  'Controller',
  'RestController',
  'Repository',
  'Configuration',
  'Inject',
  'Autowired',
  'Resource',
  'PostConstruct',
  'PreDestroy',
  'Scheduled',
  'Async',
  'Transactional',
  'Produces',
  'Consumes',
  'Endpoint',
  'ManagedBean',
  'Singleton',
  'ApplicationScoped',
  'RequestScoped',
  'SessionScoped'
]);

function normalizeAnnotation(name: string): string {
  const clean = name.replace(/^@/, '').trim();
  return clean.split('.').pop() ?? clean;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks whether a given class, method, or field carries enterprise framework
 * lifecycle annotations (Spring, CDI, Jakarta, Java EE).
 */
export function checkFrameworkAnnotations(
  cls?: JavaClassDeclIR,
  method?: JavaMethodSignatureIR,
  field?: JavaFieldIR
): string | undefined {
  if (method) {
    for (const ann of method.annotations) {
      const norm = normalizeAnnotation(ann);
      if (FRAMEWORK_ANNOTATIONS.has(norm)) return `@${norm}`;
    }
  }

  if (field) {
    for (const ann of field.annotations) {
      const norm = normalizeAnnotation(ann);
      if (FRAMEWORK_ANNOTATIONS.has(norm)) return `@${norm}`;
    }
  }

  if (cls) {
    for (const ann of cls.annotations) {
      const norm = normalizeAnnotation(ann);
      if (FRAMEWORK_ANNOTATIONS.has(norm)) return `@${norm}`;
    }
  }

  return undefined;
}

export type JavaFileAccess = Readonly<Record<string, string>> | {
  readonly trackedFiles: readonly string[];
  readTextFile(relativePath: string): string | undefined;
};

function getFileEntries(files: JavaFileAccess): { trackedFiles: readonly string[]; getText: (f: string) => string | undefined } {
  if ('readTextFile' in files && typeof (files as any).readTextFile === 'function') {
    return {
      trackedFiles: (files as any).trackedFiles as readonly string[],
      getText: (f) => (files as any).readTextFile(f)
    };
  }
  return {
    trackedFiles: Object.keys(files),
    getText: (f) => (files as Record<string, string>)[f]
  };
}

/**
 * Scans META-INF/services/ descriptor files to check if the given provider FQCN
 * is registered as a Service Provider Interface (SPI) implementation.
 */
export function scanSpiDescriptors(
  fqcn: string,
  files: JavaFileAccess
): string | undefined {
  if (!fqcn) return undefined;
  const fqcnRegex = new RegExp(`^\\s*${escapeRegex(fqcn)}\\s*$`, 'm');
  const { trackedFiles, getText } = getFileEntries(files);

  for (const filePath of trackedFiles) {
    const norm = filePath.replace(/\\/g, '/');
    if (norm.includes('META-INF/services/') || norm.startsWith('META-INF/services/')) {
      const content = getText(filePath);
      if (content && fqcnRegex.test(content)) {
        return filePath;
      }
    }
  }

  return undefined;
}

/**
 * Scans enterprise XML configuration files (portlet.xml, web.xml, Spring context,
 * OSGi declarative services component.xml) for literal occurrences of provider FQCN.
 */
export function scanXmlDescriptors(
  fqcn: string,
  simpleName: string,
  files: JavaFileAccess
): string | undefined {
  if (!fqcn) return undefined;
  const fqcnPattern = new RegExp(`(?:class|type|implementation|id|portlet-class|servlet-class|filter-class|listener-class)\\s*=\\s*["']${escapeRegex(fqcn)}["']|<(?:portlet-class|servlet-class|filter-class|listener-class)>\\s*${escapeRegex(fqcn)}\\s*<`, 'i');
  const { trackedFiles, getText } = getFileEntries(files);

  for (const filePath of trackedFiles) {
    const norm = filePath.replace(/\\/g, '/').toLowerCase();
    if (norm.endsWith('.xml') || norm.endsWith('.properties') || norm.includes('osgi-inf/')) {
      const content = getText(filePath);
      if (content && fqcnPattern.test(content)) {
        return filePath;
      }
    }
  }

  return undefined;
}

/**
 * Comprehensive framework reachability scanner (§4.4).
 */
export function scanProviderFrameworkReachability(
  providerId: string,
  fqcn: string,
  simpleName: string,
  files: JavaFileAccess,
  cls?: JavaClassDeclIR,
  method?: JavaMethodSignatureIR,
  field?: JavaFieldIR
): FrameworkReachabilityEvidence | undefined {
  // 1. Annotation scan
  const matchedAnn = checkFrameworkAnnotations(cls, method, field);
  if (matchedAnn) {
    return {
      providerId,
      reachabilityKind: 'ANNOTATION',
      matchedToken: matchedAnn
    };
  }

  // 2. SPI descriptors
  const matchedSpi = scanSpiDescriptors(fqcn, files);
  if (matchedSpi) {
    return {
      providerId,
      reachabilityKind: 'SPI_DESCRIPTOR',
      descriptorFile: matchedSpi,
      matchedToken: fqcn
    };
  }

  // 3. XML descriptors
  const matchedXml = scanXmlDescriptors(fqcn, simpleName, files);
  if (matchedXml) {
    return {
      providerId,
      reachabilityKind: 'XML_DESCRIPTOR',
      descriptorFile: matchedXml,
      matchedToken: fqcn
    };
  }

  return undefined;
}
