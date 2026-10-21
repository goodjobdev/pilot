import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,readFile,readdir,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_FORMAT,ARCHIVE_FORMAT_VERSION,ARCHIVE_MAGIC,AUTHENTICATION_FAILURE,HEADER_MAX_BYTES,KDF_PARAMETERS,
  MIN_PASSPHRASE_LENGTH,PayloadReader,PASSPHRASE_ENV,PASSPHRASE_STDIN_ENV,deriveArchiveKey,encodeRecord,
  buildHeader,isAuthenticationFailure,normalizePassphrase,openArchive,parseArchiveHeader,resolvePassphrase,
  validateKdfParameters,writeArchive
} from '../../scripts/backup-crypto.mjs';

const PASSPHRASE = 'a-sufficiently-long-archive-passphrase';
const OTHER_PASSPHRASE = 'a-different-long-enough-archive-passphrase';
const temporary = () => mkdtemp(join(tmpdir(),'pilot-crypto-'));

/** One archive sealed over the given plaintext records, with the documented parameters. */
async function seal(path:string,records:Buffer[],passphrase = PASSPHRASE) {
  const salt = randomBytes(16),nonce = randomBytes(12);
  const header = buildHeader({ created:new Date().toISOString(),kdf:KDF_PARAMETERS,salt,nonce,app:null });
  await writeArchive(path,{ header,body: asBody(records),passphrase });
  return { header,salt,nonce };
}
async function* asBody(records:Buffer[]) { for (const record of records) yield record; }
/** Read one archive to its end, returning the plaintext and whether the tag verified. */
async function readAll(path:string,passphrase = PASSPHRASE) {
  const archive = await openArchive(path,{ passphrase });
  let plaintext = Buffer.alloc(0);
  let failure:string|null = null;
  try {
    for await (const chunk of archive.plaintext()) plaintext = Buffer.concat([plaintext,chunk]);
  } catch (error) { failure = (error as Error).message; }
  const authenticated = archive.authenticated();
  await archive.close();
  return { plaintext,failure,authenticated,header:archive.header };
}

test('a passphrase is refused when it is missing, empty, blank, not text or trivially short',async()=>{
 assert.throws(()=>normalizePassphrase(undefined as unknown as string),/must be text/);
 assert.throws(()=>normalizePassphrase(''),/is empty/);
 assert.throws(()=>normalizePassphrase('   '),/is blank/);
 assert.throws(()=>normalizePassphrase('short'),/shorter than 12/);
 assert.equal(MIN_PASSPHRASE_LENGTH,12);
 assert.equal(normalizePassphrase('a-sufficiently-long-one').length,23,'a long enough passphrase becomes a buffer');
 // The environment is the documented source, and an environment variable set to empty is a refusal.
 assert.deepEqual(await resolvePassphrase({ env:{ [PASSPHRASE_ENV]:'from-the-environment-value' } }),Buffer.from('from-the-environment-value'));
 await assert.rejects(resolvePassphrase({ env:{ [PASSPHRASE_ENV]:'' } }),/set but empty/);
 await assert.rejects(resolvePassphrase({ env:{} }),/never taken from the command line/);
 await assert.rejects(resolvePassphrase({ env:{ [PASSPHRASE_ENV]:'too-short' } }),/shorter than 12/);
 // stdin is read only when the operator opts in, so an unattended run can never block on a terminal.
 let reads = 0;
 const readStdin = async () => { reads += 1; return 'a-passphrase-on-standard-input'; };
 assert.deepEqual(await resolvePassphrase({ env:{ [PASSPHRASE_STDIN_ENV]:'1' },readStdin }),Buffer.from('a-passphrase-on-standard-input'));
 assert.equal(reads,1);
 await assert.rejects(resolvePassphrase({ env:{},readStdin }),/never taken from the command line/);
 assert.equal(reads,1,'without the opt-in, stdin is never read');
});

test('an archive round trips through the documented header and authenticates as a whole',async()=>{
 const root = await temporary();
 const path = join(root,'backup.pbkp');
 const { header } = await seal(path,[encodeRecord({ kind:'manifest',n:1 }),Buffer.from('payload bytes')]);
 const raw = await readFile(path);
 assert.ok(raw.subarray(0,8).equals(ARCHIVE_MAGIC),'the archive starts with its magic bytes');
 assert.equal(header.format,ARCHIVE_FORMAT);
 assert.equal(header.version,ARCHIVE_FORMAT_VERSION);
 assert.equal(header.cipher,'aes-256-gcm');
 assert.deepEqual(header.kdf,{ name:'scrypt',N:KDF_PARAMETERS.N,r:KDF_PARAMETERS.r,p:KDF_PARAMETERS.p,keyLength:KDF_PARAMETERS.keyLength });
 assert.equal(header.salt.length,32,'the header carries the salt as hex');
 assert.equal(header.nonce.length,24,'the header carries the nonce as hex');
 const read = await readAll(path);
 assert.equal(read.failure,null);
 assert.equal(read.authenticated,true);
 assert.equal(read.plaintext.toString('utf8'),'{"kind":"manifest","n":1}\npayload bytes');
 assert.equal(await stat(path).then(info=>info.isFile()),true,'the on-disk archive is one single file');
 assert.deepEqual(await readdir(root),['backup.pbkp'],'nothing else is written beside it');
});
test('a wrong passphrase and a tampered ciphertext are both refused by authentication',async()=>{
 const root = await temporary();
 const path = join(root,'backup.pbkp');
 await seal(path,[encodeRecord({ kind:'manifest',n:1 }),Buffer.from('payload bytes')]);
 const wrong = await readAll(path,OTHER_PASSPHRASE);
 assert.equal(wrong.authenticated,false,'the tag never verifies under the wrong key');
 assert.match(wrong.failure ?? '',/did not authenticate|not valid JSON|readable manifest record|unreadable/);
 const bytes = await readFile(path);
 const tampered = Buffer.from(bytes);
 tampered[tampered.length - 20] ^= 0x01;
 await writeFile(join(root,'tampered.pbkp'),tampered);
 const read = await readAll(join(root,'tampered.pbkp'));
 assert.equal(read.authenticated,false);
 assert.match(read.failure ?? '',/did not authenticate|not valid JSON|readable manifest record|unreadable/);
 // The header is authenticated too: flipping a salt character invalidates the whole archive.
 const headerTampered = Buffer.from(bytes);
 const saltAt = headerTampered.indexOf(Buffer.from('"salt":"'));
 assert.ok(saltAt > 0,'the header really holds the salt');
 headerTampered[saltAt + 12] = headerTampered[saltAt + 12] === 0x61 ? 0x62 : 0x61;
 await writeFile(join(root,'header-tampered.pbkp'),headerTampered);
 const headerRead = await readAll(join(root,'header-tampered.pbkp'));
 assert.equal(headerRead.authenticated,false,'a rewritten header is covered by the tag');
});
test('a truncated archive is refused, at the header and at the payload',async()=>{
 const root = await temporary();
 const path = join(root,'backup.pbkp');
 await seal(path,[encodeRecord({ kind:'manifest',n:1 }),Buffer.from('payload bytes')]);
 const bytes = await readFile(path);
 assert.equal(isAuthenticationFailure(new Error(AUTHENTICATION_FAILURE)),true);
 await writeFile(join(root,'short-header.pbkp'),bytes.subarray(0,6));
 await assert.rejects(openArchive(join(root,'short-header.pbkp'),{ passphrase:PASSPHRASE }),/truncated/);
 const headerLength = bytes.readUInt32BE(8);
 await writeFile(join(root,'short-body.pbkp'),bytes.subarray(0,12 + headerLength + 4));
 await assert.rejects(openArchive(join(root,'short-body.pbkp'),{ passphrase:PASSPHRASE }),/truncated inside its header/);
 await writeFile(join(root,'cut-tail.pbkp'),bytes.subarray(0,bytes.length - 8));
 const read = await readAll(join(root,'cut-tail.pbkp'));
 assert.equal(read.authenticated,false,'a cut tail fails the tag instead of yielding the prefix');
});
test('a file that is not an archive, or an unsupported version, is refused by name',async()=>{
 const root = await temporary();
 await writeFile(join(root,'plain.pbkp'),'this is not an archive, it is a text file of a plausible size\n');
 await assert.rejects(openArchive(join(root,'plain.pbkp'),{ passphrase:PASSPHRASE }),/magic bytes/);
 await writeFile(join(root,'future.pbkp'),Buffer.concat([ARCHIVE_MAGIC,Buffer.from([0,0,0,2]),Buffer.from('{}'),Buffer.alloc(16)]));
 await assert.rejects(openArchive(join(root,'future.pbkp'),{ passphrase:PASSPHRASE }),/Unrecognised archive format/);
 // A reader never accepts a passphrase the writer would have refused, and the writer itself refuses it.
 const valid = join(root,'valid.pbkp');
 await seal(valid,[encodeRecord({ kind:'end',files:0 })]);
 await assert.rejects(openArchive(valid,{ passphrase:'short' }),/shorter than 12/);
 await assert.rejects(seal(join(root,'refused.pbkp'),[encodeRecord({ kind:'end',files:0 })],''),/is empty/);
 const header = buildHeader({ created:new Date().toISOString(),kdf:KDF_PARAMETERS,salt:randomBytes(16),nonce:randomBytes(12),app:null });
 assert.throws(()=>parseArchiveHeader(Buffer.from(JSON.stringify({ ...header,version:1 }))),/Unsupported archive format version/);
 assert.throws(()=>parseArchiveHeader(Buffer.from(JSON.stringify({ ...header,format:'something-else' }))),/Unrecognised archive format/);
 assert.throws(()=>parseArchiveHeader(Buffer.from(JSON.stringify({ ...header,cipher:'aes-128-cbc' }))),/Unsupported archive cipher/);
 assert.equal(parseArchiveHeader(Buffer.from(JSON.stringify({ ...header,kdf:{ ...header.kdf,N:1024 } }))).kdf.N,1024,'a header is obeyed within the documented ceilings, never guessed at');
 assert.throws(()=>parseArchiveHeader(Buffer.from(JSON.stringify({ ...header,kdf:{ ...header.kdf,N:1024 + 4 } }))),/power of two/);
 assert.throws(()=>parseArchiveHeader(Buffer.alloc(HEADER_MAX_BYTES + 1,0x20)),/exceeds/);
});
test('hostile KDF parameters are refused before any key is derived',async()=>{
 assert.throws(()=>validateKdfParameters({ name:'scrypt',N:2 ** 30,r:8,p:1,keyLength:32 }),/power of two no larger than/);
 assert.throws(()=>validateKdfParameters({ name:'scrypt',N:32768,r:9999,p:1,keyLength:32 }),/between 1 and 64/);
 assert.throws(()=>validateKdfParameters({ name:'argon2',N:32768,r:8,p:1,keyLength:32 }),/Unsupported archive KDF/);
 assert.throws(()=>validateKdfParameters({ name:'scrypt',N:32768,r:8,p:1,keyLength:8 }),/keyLength=8/);
 assert.throws(()=>deriveArchiveKey(Buffer.from('passphrase-value'),Buffer.alloc(16),{ name:'scrypt',N:2 ** 30,r:8,p:1,keyLength:32 }),/power of two no larger than/);
 const key = deriveArchiveKey(Buffer.from('passphrase-value'),Buffer.alloc(16,3),KDF_PARAMETERS);
 assert.equal(key.length,32,'the derived key is 256 bits');
 assert.notDeepEqual(key,deriveArchiveKey(Buffer.from('passphrase-value'),Buffer.alloc(16,4),KDF_PARAMETERS),'the salt changes the key');
 key.fill(0);
});
test('a partial archive is removed only when this call created the file itself',async()=>{
 const root = await temporary();
 const header = buildHeader({ created:new Date().toISOString(),kdf:KDF_PARAMETERS,salt:randomBytes(16),nonce:randomBytes(12),app:null });
 // The exclusive create fails, so this call created nothing and may remove nothing.
 const existing = join(root,'existing.pbkp');
 await writeFile(existing,'a file that was here first\n');
 await assert.rejects(writeArchive(existing,{ header,body:asBody([encodeRecord({ kind:'end',files:0 })]),passphrase:PASSPHRASE }),/EEXIST/);
 assert.equal(await readFile(existing,'utf8'),'a file that was here first\n','an existing file is never overwritten or removed');
 // A failure after the create removes exactly the partial archive this call made, and nothing else.
 const partial = join(root,'partial.pbkp');
 async function* failingBody() { yield Buffer.from('bytes already sealed into the ciphertext'); throw new Error('synthetic failure inside the payload'); }
 await assert.rejects(writeArchive(partial,{ header,body:failingBody(),passphrase:PASSPHRASE }),/synthetic failure inside the payload/);
 assert.equal(await stat(partial).then(()=>true).catch(()=>false),false,'a partial archive this call created is removed');
 assert.deepEqual(await readdir(root),['existing.pbkp'],'nothing else is left beside it');
 // A completed archive is never removed by its own writer.
 const complete = join(root,'complete.pbkp');
 await writeArchive(complete,{ header,body:asBody([encodeRecord({ kind:'end',files:0 })]),passphrase:PASSPHRASE });
 assert.equal(await stat(complete).then(info=>info.isFile()),true,'a completed archive stays where it was written');
 await rm(root,{recursive:true,force:true});
});
test('the payload reader yields records and exact file bytes, and refuses a cut payload',async()=>{
 const records = [encodeRecord({ kind:'manifest',manifest:{ files:[] } }),encodeRecord({ kind:'file',path:'catalog.json',size:5 }),Buffer.from('12345'),encodeRecord({ kind:'end',files:1 })];
 const reader = new PayloadReader(asBody(records));
 assert.deepEqual(JSON.parse(await reader.readLine()),{ kind:'manifest',manifest:{ files:[] } });
 assert.deepEqual(JSON.parse(await reader.readLine()),{ kind:'file',path:'catalog.json',size:5 });
 const collected:Buffer[] = [];
 for await (const chunk of reader.readExactly(5)) collected.push(chunk);
 assert.equal(Buffer.concat(collected).toString('utf8'),'12345');
 assert.deepEqual(JSON.parse(await reader.readLine()),{ kind:'end',files:1 });
 await reader.drain();
 const cut = new PayloadReader(asBody([encodeRecord({ kind:'file',path:'catalog.json',size:9 }),Buffer.from('12345')]));
 await cut.readLine();
 await assert.rejects(async()=>{ for await (const chunk of cut.readExactly(9)) void chunk; },/truncated/);
 const empty = new PayloadReader(asBody([]));
 await assert.rejects(empty.readLine(),/truncated/);
});
