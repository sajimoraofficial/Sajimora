import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { ProjectFactSpool } from '../../src/sajimora/indexed/ProjectFactSpool';

const spool = new ProjectFactSpool<{ declarations: string[] }>();
const ticket = spool.write({ declarations: ['api'] });
assert.deepEqual(spool.read(ticket), { declarations: ['api'] });
fs.writeFileSync(ticket.path, '{"declarations":["forged"]}');
assert.throws(() => spool.read(ticket), /PROJECT_FACT_SPOOL_CORRUPT/);
spool.close();
assert.equal(fs.existsSync(ticket.path), false);
console.log('Project fact spool integrity: PASS');
