import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ProjectFactTicket {
  readonly path: string;
  readonly sha256: string;
}

/** Holds serializable project facts on disk while the generation identity is
 * being computed. No ts.Program or project fact graph is retained here. */
export class ProjectFactSpool<T> {
  private readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'sajimora-project-facts-'));
  private readonly pending = new Set<string>();
  private nextId = 0;

  public write(value: T): ProjectFactTicket {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('PROJECT_FACTS_NOT_SERIALIZABLE');
    const bytes = Buffer.from(serialized, 'utf8');
    const file = path.join(this.root, `${++this.nextId}.json`);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    this.pending.add(file);
    return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  public read(ticket: ProjectFactTicket): T {
    if (!this.pending.has(ticket.path)) throw new Error('PROJECT_FACT_TICKET_UNKNOWN');
    const bytes = fs.readFileSync(ticket.path);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== ticket.sha256) throw new Error('PROJECT_FACT_SPOOL_CORRUPT');
    return JSON.parse(bytes.toString('utf8')) as T;
  }

  public discard(ticket: ProjectFactTicket): void {
    if (!this.pending.delete(ticket.path)) return;
    fs.unlinkSync(ticket.path);
  }

  public close(): void {
    for (const file of this.pending) fs.unlinkSync(file);
    this.pending.clear();
    fs.rmdirSync(this.root);
  }
}
