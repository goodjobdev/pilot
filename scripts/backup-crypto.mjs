/**
 * The offline archive's cryptography: one passphrase-derived key, one streamed AES-256-GCM payload,
 * and a versioned, authenticated header. This module has no dependency outside node's own builtins,
 * so the operator-facing tools in scripts/ run under plain node.
 *
 * The header is authenticated as additional data, so the archived format version, the KDF parameters,
 * the salt and the nonce are covered by the same tag as the payload: a rewritten header fails
 * authentication instead of being silently obeyed. Nothing in this module ever logs, returns or
 * writes the passphrase or the derived key.
 */
import { createCipheriv,createDecipheriv,createHash,scryptSync } from 'node:crypto';
import { constants } from 'node:fs';
import { open,unlink } from 'node:fs/promises';

/** The archive format and the version this module writes and reads. */
export const ARCHIVE_FORMAT = 'pilot-backup';
export const ARCHIVE_FORMAT_VERSION = 2;
/** Eight fixed bytes in front of every archive: naming the file is not proof of its format. */
export const ARCHIVE_MAGIC = Buffer.from('PILOTBKP','ascii');
export const CIPHER_NAME = 'aes-256-gcm';
export const KDF_NAME = 'scrypt';
/**
 * The documented KDF parameters. scrypt with N=2^15, r=8, p=1 needs about 32 MiB per derivation and
 * is deliberately slow enough to make guessing a passphrase against a stolen archive expensive.
 */
export const KDF_PARAMETERS = Object.freeze({ name: KDF_NAME, N: 32768, r: 8, p: 1, keyLength: 32 });
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** A header is a small JSON record; anything larger is not an archive this tool wrote. */
export const HEADER_MAX_BYTES = 65_536;
/** A trivially short passphrase cannot protect a file that leaves the machine. */
export const MIN_PASSPHRASE_LENGTH = 12;
export const PASSPHRASE_ENV = 'PILOT_BACKUP_PASSPHRASE';
export const PASSPHRASE_STDIN_ENV = 'PILOT_BACKUP_PASSPHRASE_STDIN';
/** Reading and cipher blocks: the archive is streamed, so memory stays bounded for a large root. */
export const READ_BLOCK_BYTES = 64 * 1024;
/** A payload record (the manifest) must fit; file contents are streamed and never held in full. */
export const PAYLOAD_RECORD_MAX_BYTES = 32 * 1024 * 1024;
/** Ceilings applied to a header that this tool did not write, checked before any key is derived. */
const KDF_LIMITS = Object.freeze({ maxN: 1 << 20, maxR: 64, maxP: 16, maxKeyLength: 64 });
const KDF_MAX_MEMORY_BYTES = 512 * 1024 * 1024;

/** The one authentication failure. A wrong passphrase and a tampered archive are the same event to GCM. */
export const AUTHENTICATION_FAILURE = 'The archive did not authenticate: it is corrupted or truncated, or the passphrase is wrong. Nothing was written to the destination.';
/** True when an error is that authentication failure, so a caller does not mask it as a parse fault. */
export const isAuthenticationFailure = error => error instanceof Error && error.message === AUTHENTICATION_FAILURE;

function hexBuffer(value,bytes,label) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]*$/.test(value))
    throw new Error('The archive header carries no usable ' + label + ': it must be ' + (bytes * 2) + ' lowercase hex characters');
  return Buffer.from(value,'hex');
}
function u32(value) { const out = Buffer.alloc(4); out.writeUInt32BE(value,0); return out; }
async function readExact(handle,buffer,position) {
  let read = 0;
  while (read < buffer.length) {
    const { bytesRead } = await handle.read(buffer,read,buffer.length - read,position + read);
    if (bytesRead === 0) throw new Error('The archive ended inside its header');
    read += bytesRead;
  }
  return buffer;
}
async function writeAll(handle,buffer) {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(buffer,written,buffer.length - written);
    if (bytesWritten === 0) throw new Error('The archive could not be written');
    written += bytesWritten;
  }
}

/** Reject a missing, empty, blank or trivially short passphrase instead of encrypting with it. */
export function normalizePassphrase(value,label = 'backup passphrase') {
  if (typeof value !== 'string') throw new Error('Refusing to continue: the ' + label + ' must be text');
  if (value.length === 0) throw new Error('Refusing to continue: the ' + label + ' is empty');
  if (value.trim().length === 0) throw new Error('Refusing to continue: the ' + label + ' is blank');
  if (value.length < MIN_PASSPHRASE_LENGTH)
    throw new Error('Refusing to continue: the ' + label + ' is shorter than ' + MIN_PASSPHRASE_LENGTH + ' characters, which cannot protect an offline archive');
  return Buffer.from(value,'utf8');
}

/** One passphrase line, bounded and never echoed. Reads at most 1024 characters. */
export async function readPassphraseFromStdin(stream = process.stdin) {
  if (typeof stream?.setEncoding === 'function') stream.setEncoding('utf8');
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    const cut = text.indexOf('\n');
    if (cut >= 0) { text = text.slice(0,cut); break; }
    if (text.length > 1024) throw new Error('Refusing to continue: the passphrase on stdin is longer than 1024 characters');
  }
  return text.replace(/\r$/,'');
}

/**
 * Where the passphrase comes from, in order: an explicit programmatic value, the environment, then
 * stdin when the operator opts in with PILOT_BACKUP_PASSPHRASE_STDIN=1. It is never read from argv:
 * a command line is visible in the process table and in the shell history.
 */
export async function resolvePassphrase(options = {}) {
  const env = options.env ?? process.env;
  if (options.passphrase !== undefined) return normalizePassphrase(options.passphrase);
  const fromEnvironment = env[PASSPHRASE_ENV];
  if (fromEnvironment !== undefined) {
    if (fromEnvironment === '') throw new Error('Refusing to continue: ' + PASSPHRASE_ENV + ' is set but empty');
    return normalizePassphrase(fromEnvironment,PASSPHRASE_ENV);
  }
  if (env[PASSPHRASE_STDIN_ENV] === '1') {
    const reader = options.readStdin ?? readPassphraseFromStdin;
    return normalizePassphrase(await reader(),'passphrase read from stdin');
  }
  throw new Error('No backup passphrase was supplied. Set ' + PASSPHRASE_ENV + ' in the environment, or set ' + PASSPHRASE_STDIN_ENV + '=1 to read one line from stdin. A passphrase is never taken from the command line.');
}

/** Validate the parameters a header carries before deriving anything, so a hostile header cannot ask for unbounded work. */
export function validateKdfParameters(kdf) {
  if (!kdf || typeof kdf !== 'object') throw new Error('The archive header carries no KDF parameters');
  const { name,N,r,p,keyLength } = kdf;
  if (name !== KDF_NAME) throw new Error('Unsupported archive KDF ' + JSON.stringify(name) + '; this tool reads ' + KDF_NAME);
  for (const [label,value] of [['N',N],['r',r],['p',p],['keyLength',keyLength]])
    if (!Number.isSafeInteger(value)) throw new Error('The archive KDF parameter ' + label + ' must be a whole number');
  if (N < 2 || (N & (N - 1)) !== 0 || N > KDF_LIMITS.maxN)
    throw new Error('Refusing the archive KDF: N=' + N + ' must be a power of two no larger than ' + KDF_LIMITS.maxN);
  if (r < 1 || r > KDF_LIMITS.maxR) throw new Error('Refusing the archive KDF: r=' + r + ' must be between 1 and ' + KDF_LIMITS.maxR);
  if (p < 1 || p > KDF_LIMITS.maxP) throw new Error('Refusing the archive KDF: p=' + p + ' must be between 1 and ' + KDF_LIMITS.maxP);
  if (keyLength < 16 || keyLength > KDF_LIMITS.maxKeyLength) throw new Error('Refusing the archive KDF: keyLength=' + keyLength + ' must be between 16 and ' + KDF_LIMITS.maxKeyLength);
  // scrypt's own requirement plus headroom, and never more than the documented ceiling.
  const maxmem = 256 * N * r + 64 * 1024 * 1024;
  if (maxmem > KDF_MAX_MEMORY_BYTES) throw new Error('Refusing the archive KDF: these parameters would need more than ' + (KDF_MAX_MEMORY_BYTES / 1024 / 1024) + ' MiB to derive a key');
  return { name:KDF_NAME,N,r,p,keyLength,maxmem };
}

/**
 * The passphrase as key material. A string is normalized here — so a missing, empty, blank or
 * trivially short passphrase is refused by the writer and the reader alike — and a buffer is used as
 * given. The returned flag says whether this module owns the buffer and must zero it.
 */
function keyMaterial(value) {
  if (Buffer.isBuffer(value)) return { secret: value,owned: false };
  return { secret: normalizePassphrase(value),owned: true };
}

/** The one place a key is derived. The caller owns the returned buffer and should zero it when done. */
export function deriveArchiveKey(passphrase,salt,kdf) {
  const parameters = validateKdfParameters(kdf);
  if (!Buffer.isBuffer(passphrase) || passphrase.length === 0 || !Buffer.isBuffer(salt)) throw new Error('Invalid archive key material');
  return scryptSync(passphrase,salt,parameters.keyLength,{ N:parameters.N,r:parameters.r,p:parameters.p,maxmem:parameters.maxmem });
}

/** The pseudorandom identity of one archive, used in the restore marker. Never the payload. */
export async function digestFile(path) {
  const hash = createHash('sha256');
  const handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(READ_BLOCK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer,0,buffer.length,null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0,bytesRead));
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

/** The authenticated header record: format version, KDF parameters, salt and nonce, all in the clear but covered by the tag. */
export function buildHeader(input) {
  const kdf = validateKdfParameters(input.kdf);
  if (!Buffer.isBuffer(input.salt) || input.salt.length !== SALT_BYTES) throw new Error('An archive salt is exactly ' + SALT_BYTES + ' bytes');
  if (!Buffer.isBuffer(input.nonce) || input.nonce.length !== NONCE_BYTES) throw new Error('An archive nonce is exactly ' + NONCE_BYTES + ' bytes');
  if (typeof input.created !== 'string' || Number.isNaN(Date.parse(input.created))) throw new Error('An archive header carries a creation time');
  return {
    format:ARCHIVE_FORMAT,version:ARCHIVE_FORMAT_VERSION,cipher:CIPHER_NAME,created:input.created,
    kdf:{ name:kdf.name,N:kdf.N,r:kdf.r,p:kdf.p,keyLength:kdf.keyLength },
    salt:input.salt.toString('hex'),nonce:input.nonce.toString('hex'),
    app:input.app ?? null
  };
}

/** Validate a header exactly as it will be authenticated. An unknown format or version is refused, never guessed at. */
export function parseArchiveHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('The archive carries no header');
  if (bytes.length > HEADER_MAX_BYTES) throw new Error('The archive header exceeds ' + HEADER_MAX_BYTES + ' bytes and is not an archive this tool wrote');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('The archive header is not valid JSON: this is not a Pilot backup archive'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The archive header is not a record');
  if (value.format !== ARCHIVE_FORMAT) throw new Error('Unrecognised archive format ' + JSON.stringify(value.format) + ': this is not a Pilot backup archive');
  if (value.version !== ARCHIVE_FORMAT_VERSION)
    throw new Error('Unsupported archive format version ' + JSON.stringify(value.version) + ': this tool writes and reads version ' + ARCHIVE_FORMAT_VERSION + '. A version-1 backup is a plaintext directory and is read by the documented legacy restore branch.');
  if (value.cipher !== CIPHER_NAME) throw new Error('Unsupported archive cipher ' + JSON.stringify(value.cipher) + '; this tool reads ' + CIPHER_NAME);
  if (typeof value.created !== 'string' || Number.isNaN(Date.parse(value.created))) throw new Error('The archive header carries no usable creation time');
  const salt = hexBuffer(value.salt,SALT_BYTES,'salt');
  const nonce = hexBuffer(value.nonce,NONCE_BYTES,'nonce');
  return { header:value,salt,nonce,kdf:validateKdfParameters(value.kdf) };
}

/**
 * Write one single-file archive: magic, header, streamed AES-256-GCM ciphertext, authentication tag.
 * The payload is never held in memory; it is consumed from the given async iterable and written as
 * it arrives. The file is created exclusively and privately, and its tag is appended after the
 * ciphertext so a reader can authenticate the whole archive before anything it holds is used.
 *
 * Only a partial archive this call created itself is ever removed: the exclusive create is the point
 * at which this process knows the path is its own, and no failure before it unlinks anything. A file
 * that appeared at the archive path concurrently is therefore never deleted — its own exclusive create
 * is what fails first — and this function never removes an archive it completed.
 */
export async function writeArchive(path,input) {
  const headerBytes = Buffer.from(JSON.stringify(input.header),'utf8');
  if (headerBytes.length === 0 || headerBytes.length > HEADER_MAX_BYTES) throw new Error('The archive header is outside the supported size');
  const { salt,nonce,kdf } = parseArchiveHeader(headerBytes);
  const material = keyMaterial(input.passphrase);
  let key;
  try { key = deriveArchiveKey(material.secret,salt,kdf); }
  finally { if (material.owned) material.secret.fill(0); }
  const cipher = createCipheriv(CIPHER_NAME,key,nonce);
  cipher.setAAD(headerBytes);
  const prefix = Buffer.concat([ARCHIVE_MAGIC,u32(headerBytes.length),headerBytes]);
  const handle = await open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),0o600);
  let bytes = prefix.length;
  let completed = false;
  try {
    await writeAll(handle,prefix);
    for await (const chunk of input.body) {
      if (!chunk || chunk.length === 0) continue;
      const block = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const sealed = cipher.update(block);
      if (sealed.length) { await writeAll(handle,sealed); bytes += sealed.length; }
    }
    const tail = cipher.final();
    if (tail.length) { await writeAll(handle,tail); bytes += tail.length; }
    const tag = cipher.getAuthTag();
    await writeAll(handle,tag);
    bytes += tag.length;
    await handle.sync();
    completed = true;
  } finally {
    await handle.close().catch(() => {});
    key.fill(0);
    // 'completed' is the record of creation: this call created the file (the exclusive open above) and
    // did not finish writing it, so that partial archive — and only it — is removed here.
    if (!completed) await unlink(path).catch(() => {});
  }
  return { bytes,header:input.header,ciphertextBytes:bytes - prefix.length - TAG_BYTES };
}

/**
 * Open one archive for streaming reads. The header is validated and the tag is read from the end of
 * the file before any plaintext is produced, so a truncated, reordered or unauthenticated archive is
 * refused rather than partially trusted. 'authenticated()' only reports true once the payload was
 * consumed to its end and the tag verified: a caller that stops early has verified nothing.
 */
export async function openArchive(path,options) {
  const handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('The archive is not a regular file');
    const size = info.size;
    const minimum = ARCHIVE_MAGIC.length + 4 + TAG_BYTES;
    if (size < minimum) throw new Error('The archive is truncated: ' + size + ' bytes is below the smallest possible archive');
    const head = await readExact(handle,Buffer.alloc(ARCHIVE_MAGIC.length + 4),0);
    if (!head.subarray(0,ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC))
      throw new Error('The archive does not begin with the Pilot backup magic bytes: this is not a Pilot backup archive');
    const headerLength = head.readUInt32BE(ARCHIVE_MAGIC.length);
    if (headerLength === 0 || headerLength > HEADER_MAX_BYTES)
      throw new Error('The archive header length ' + headerLength + ' is outside the supported range of 1 to ' + HEADER_MAX_BYTES + ' bytes');
    const bodyStart = ARCHIVE_MAGIC.length + 4 + headerLength;
    if (bodyStart + TAG_BYTES > size) throw new Error('The archive is truncated inside its header');
    const headerBytes = await readExact(handle,Buffer.alloc(headerLength),ARCHIVE_MAGIC.length + 4);
    const parsed = parseArchiveHeader(headerBytes);
    const tag = await readExact(handle,Buffer.alloc(TAG_BYTES),size - TAG_BYTES);
    const material = keyMaterial(options.passphrase);
    let key;
    try { key = deriveArchiveKey(material.secret,parsed.salt,parsed.kdf); }
    finally { if (material.owned) material.secret.fill(0); }
    const decipher = createDecipheriv(CIPHER_NAME,key,parsed.nonce);
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(tag);
    const end = size - TAG_BYTES;
    let offset = bodyStart;
    let authenticated = false;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      key.fill(0);
      await handle.close();
    };
    async function* plaintext() {
      try {
        while (offset < end) {
          const length = Math.min(READ_BLOCK_BYTES,end - offset);
          const block = Buffer.alloc(length);
          const { bytesRead } = await handle.read(block,0,length,offset);
          if (bytesRead === 0) throw new Error(AUTHENTICATION_FAILURE);
          offset += bytesRead;
          const opened = decipher.update(block.subarray(0,bytesRead));
          if (opened.length) yield opened;
        }
        const tail = decipher.final();
        if (tail.length) yield tail;
        authenticated = true;
      } catch (error) {
        if (isAuthenticationFailure(error)) throw error;
        throw new Error(AUTHENTICATION_FAILURE);
      }
    }
    return {
      path,header:parsed.header,salt:parsed.salt,nonce:parsed.nonce,kdf:parsed.kdf,
      headerBytes,ciphertextBytes:end - bodyStart,fileBytes:size,
      plaintext,authenticated:() => authenticated,close
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** One newline-delimited JSON record of the payload. */
export function encodeRecord(value) { return Buffer.from(JSON.stringify(value) + '\n','utf8'); }

/**
 * A bounded reader over the decrypted payload: records are newline-delimited JSON and each file
 * record is followed by exactly its recorded number of bytes, which are yielded in blocks so a large
 * file is written to disk as it is verified instead of being buffered whole.
 */
export class PayloadReader {
  constructor(source) {
    this.source = source[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
    this.finished = false;
  }
  async pull() {
    if (this.finished) return false;
    const next = await this.source.next();
    if (next.done) { this.finished = true; return false; }
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending,chunk]);
    return true;
  }
  async readLine(maxBytes = PAYLOAD_RECORD_MAX_BYTES) {
    for (;;) {
      const cut = this.pending.indexOf(0x0a);
      if (cut >= 0) {
        const line = this.pending.subarray(0,cut);
        this.pending = this.pending.subarray(cut + 1);
        if (line.length > maxBytes) throw new Error('An archive payload record exceeds ' + maxBytes + ' bytes');
        return line.toString('utf8');
      }
      if (this.pending.length > maxBytes) throw new Error('An archive payload record exceeds ' + maxBytes + ' bytes');
      if (!await this.pull()) throw new Error('The archive payload ended before its next record: the archive is truncated');
    }
  }
  async *readExactly(bytes) {
    let remaining = bytes;
    while (remaining > 0) {
      if (this.pending.length === 0 && !await this.pull()) throw new Error('The archive payload ended inside a file record: the archive is truncated');
      const take = Math.min(remaining,this.pending.length);
      const slice = this.pending.subarray(0,take);
      this.pending = this.pending.subarray(take);
      remaining -= take;
      yield slice;
    }
  }
  /** Consume whatever remains, which is what makes the stream's authentication tag verify. */
  async drain() { while (await this.pull()); }
}
