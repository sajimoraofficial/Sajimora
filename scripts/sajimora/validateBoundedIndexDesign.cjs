const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const folder = path.resolve('rust/audit/bounded-index');
const profile = JSON.parse(fs.readFileSync(path.join(folder, 'profile-v1.json'), 'utf8'));
const reservedMiB = profile.parserWorkers*profile.parserWorkerReservationMiB + profile.sourceQueueMiB + profile.factQueueMiB + profile.gitReadBufferMiB + profile.writerBatchMiB + profile.sqliteWriterCacheMiB + profile.sqliteReaderConnections*profile.sqliteReaderCacheMiB + profile.resolutionCacheMiB;
assert.equal(reservedMiB, 588);
assert.equal(profile.processTreeTargetMiB-reservedMiB, 436);
assert(profile.admissionPauseRssMiB < profile.supervisorStopRssMiB);
assert(profile.supervisorStopRssMiB < profile.processTreeTargetMiB);
const dbPath = path.join(folder, `schema-validation-${Date.now()}.sqlite`);
const db = new DatabaseSync(dbPath);
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
try {
  db.exec(fs.readFileSync(path.join(folder, 'schema-v1.sql'), 'utf8'));
  check('SQLite settings read back correctly', () => {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
    assert.equal(db.prepare('PRAGMA temp_store').get().temp_store, 1);
    assert.equal(db.prepare('PRAGMA cache_size').get().cache_size, -32768);
    assert.equal(db.prepare('PRAGMA mmap_size').get().mmap_size, 0);
  });
  const build = db.prepare('INSERT INTO builds VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  build.run('a','repo','rev-a','scope','config','engine','BUILDING',1,0,0);
  build.run('b','repo','rev-b','scope','config','engine','BUILDING',1,0,0);
  const bytes = Buffer.from('class A {}\n');
  const sha = createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO source_blobs VALUES (?, ?, ?, ?)').run(sha, bytes.length, 1, 'SEALED');
  db.prepare('INSERT INTO source_chunks VALUES (?, ?, ?)').run(sha,0,bytes);
  db.prepare('INSERT INTO parse_units VALUES (?, ?, ?, ?, ?, ?)').run('unit-a',sha,'java','grammar','extractor','COMPLETE');
  db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('a',1,'A.java','git-a',bytes.length,'java','unit-a','INDEXED');
  db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('b',2,'A.java','git-a',bytes.length,'java','unit-a','INDEXED');
  const decl = db.prepare('INSERT INTO declarations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  decl.run('unit-a',0,null,'CLASS','A','A',0,bytes.length,'{}');
  db.prepare('INSERT INTO references_ir VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('unit-a',0,0,'TYPE','A',0,1,'{}');
  db.prepare('INSERT INTO resolutions VALUES (?, ?, ?, ?, ?, ?)').run('a',1,'unit-a',0,'RESOLVED','{}');
  const target = db.prepare('INSERT INTO resolution_targets VALUES (?, ?, ?, ?, ?, ?)');
  check('Build-scoped target succeeds', () => target.run('a',1,0,1,'unit-a',0));
  check('Cross-build target is rejected', () => assert.throws(() => target.run('a',1,0,2,'unit-a',0), /FOREIGN KEY/));
  check('Missing declaration owner is rejected', () => assert.throws(() => decl.run('unit-a',1,999,'FIELD','x',null,1,2,'{}'), /FOREIGN KEY/));
  check('Oversized source chunk is rejected', () => assert.throws(() => db.prepare('INSERT INTO source_chunks VALUES (?, ?, ?)').run(sha,1,Buffer.alloc(1048577)), /CHECK/));
  check('Oversized UTF-8 fact metadata is rejected', () => assert.throws(() => decl.run('unit-a',2,null,'CLASS','B','B',0,1,JSON.stringify({text:'é'.repeat(32768)})), /CHECK/));
  check('Invalid source span is rejected', () => assert.throws(() => decl.run('unit-a',3,null,'CLASS','C','C',2,1,'{}'), /CHECK/));
  check('Duplicate discovered path is rejected', () => assert.throws(() => db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('a',3,'A.java','git-a',1,'java',null,'DISCOVERED'), /UNIQUE/));
  check('Blocked source remains a durable unknown obligation', () => {
    db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('a',4,'Large.java','git-large',100000000,'java',null,'BLOCKED');
    db.prepare('INSERT INTO obligations VALUES (?, ?, ?, ?, ?, ?, ?)').run('a',4,'large-admission','FILE_DISCOVERY','UNKNOWN','RESOURCE_LIMIT','{}');
    assert.equal(db.prepare("SELECT count(*) AS count FROM obligations WHERE build_id='a' AND status='UNKNOWN'").get().count,1);
  });
  check('Lookup has an indexed query plan', () => {
    const rows = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM declarations WHERE qualified_name=?').all('A');
    assert(rows.some(row => row.detail.includes('declaration_lookup')));
  });
  check('Draft schema passes integrity and foreign-key checks', () => {
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS version').get().version;
  fs.writeFileSync(path.join(folder, 'design-validation.json'), JSON.stringify({status:'PASS',node:process.version,sqliteVersion,checks,reservedMiB,headroomMiB:profile.processTreeTargetMiB-reservedMiB,database:dbPath,limitations:'Schema and arithmetic validation only. Runtime memory enforcement, streaming, crash recovery and parity are not implemented by this check.'},null,2));
  console.log(JSON.stringify({status:'PASS',checks:checks.length,reservedMiB,headroomMiB:436,sqliteVersion}));
} finally { db.close(); }
