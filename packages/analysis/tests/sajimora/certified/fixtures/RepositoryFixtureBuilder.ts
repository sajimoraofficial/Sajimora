import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EnvironmentCollector, CollectionResult } from '../../../../src/sajimora/certified/environment/EnvironmentCollector';
import { ProjectEntry, PackageEntry, AmbientRoot } from '../../../../../core/src/sajimora/certified/contracts';

export interface FixtureFile {
  logicalPath: string;
  content: string | Buffer;
}

export class RepositoryFixtureBuilder {
  private tempDir: string;
  private files: FixtureFile[] = [];
  private projects: ProjectEntry[] = [];
  private packages: PackageEntry[] = [];
  private ambientRoots: AmbientRoot[] = [];

  constructor() {
    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-f0-test-'));
  }

  public addFile(logicalPath: string, content: string | Buffer): this {
    this.files.push({ logicalPath, content });
    return this;
  }

  public addProject(project: ProjectEntry): this {
    this.projects.push(project);
    return this;
  }

  public build(): { repositoryRoot: string; collectionResult: CollectionResult } {
    // Write files to temp dir
    for (const file of this.files) {
      const fullPath = path.join(this.tempDir, file.logicalPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content);
    }

    // In a real fixture builder, we might initialize a Git repo here.
    // For these tests, we just use the Collector.
    const collector = new EnvironmentCollector(this.tempDir, 'test-commit-id');
    const filePaths = this.files.map(f => f.logicalPath);
    
    const collectionResult = collector.collect(filePaths, this.projects, this.packages, this.ambientRoots);

    return { repositoryRoot: this.tempDir, collectionResult };
  }

  public cleanup(): void {
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }
}
