// gitobj.ts — git object model, packfiles and pkt-line framing, stdlib only.
//
// This is the forge's git core: SHA-1 object ids, loose object encoding, tree/commit
// parsing and building, packfile read/write (including OFS_DELTA / REF_DELTA), and the
// pkt-line framing git smart HTTP speaks. It mirrors the wire formats the suite's own
// git client (program/env/src/git-client.ts) produces and parses, so the two sides agree
// byte for byte.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_NUMBERS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** SHA-1 hex of `data`. */
export function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a loose object: sha1("<type> <size>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** Whether `value` is a 40-hex object id. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-line

/** One pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** The flush packet: "0000". */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet: "0001". */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet: "0002". */
export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on a malformed length. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line truncated at length prefix');
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`pkt-line bad length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('pkt-line truncated at payload');
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Encode several pkt-lines / flush / delim markers in order. */
export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'response-end') parts.push(pktResponseEnd());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no mode');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry truncated');
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name ends with '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep < 0 ? text : text.slice(0, sep);
  const message = sep < 0 ? '' : text.slice(sep + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
  /** Extra headers (e.g. gpgsig) — each a full "key value" line. Rarely used. */
  extra?: readonly string[];
}

/** Build a commit object. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  for (const extra of fields.extra ?? []) lines.push(extra);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- deltas

function readDeltaSize(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let off = offset;
  for (;;) {
    if (off >= buf.length) throw new Error('delta size varint truncated');
    const byte = buf[off++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value, next: off };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaSize(delta, 0);
  const tgt = readDeltaSize(delta, src.next);
  if (src.value !== base.length) throw new Error(`delta expects a ${src.value}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(tgt.value);
  let written = 0;
  let off = tgt.next;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[off++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[off++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert truncated');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== tgt.value) throw new Error(`delta produced ${written} of ${tgt.value} bytes`);
  return out;
}

// ---------------------------------------------------------------- packfiles

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start] ?? 0;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('pack entry size varint truncated');
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start] ?? 0;
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('ofs-delta base offset truncated');
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack shorter than its trailer');
  return sha1(pack.subarray(0, pack.length - 20));
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  return pack.subarray(pack.length - 20).toString('hex') === packChecksum(pack);
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: GitObjectType;
  resolved?: Buffer;
  oid?: string;
}

/**
 * Read a packfile (version 2) and resolve every object, including OFS_DELTA and
 * REF_DELTA. `resolveBase` supplies a base object a thin pack leaves out.
 * Throws on any corruption; a bad checksum is a throw too.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  if (!verifyPackChecksum(pack)) throw new Error('pack trailer does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!TYPE_CODES[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: { type: GitObjectType; data: Buffer; oid: string } | undefined;
        if (entry.baseOffset !== undefined) {
          const baseEntry = byOffset.get(entry.baseOffset);
          if (!baseEntry) throw new Error(`ofs-delta base offset ${entry.baseOffset} not in pack`);
          base = resolve(baseEntry);
        } else if (entry.baseOid !== undefined) {
          const found = objects.get(entry.baseOid);
          if (found) base = { type: found.type, data: found.data, oid: entry.baseOid };
          else {
            const external = options.resolveBase?.(entry.baseOid);
            if (!external) throw new Error(`ref-delta base ${entry.baseOid} not in pack and not supplied`);
            base = { type: external.type, data: external.data, oid: entry.baseOid };
          }
        }
        if (!base) throw new Error('delta entry has no base');
        const data = applyDelta(base.data, entry.data);
        const oid = hashObject(base.type, data);
        entry.resolved = data;
        entry.resolvedType = base.type;
        entry.oid = oid;
        return { type: base.type, data, oid };
      }
      const type = TYPE_CODES[entry.typeCode];
      if (!type) throw new Error(`unknown type code ${entry.typeCode}`);
      const oid = hashObject(type, entry.data);
      entry.resolved = entry.data;
      entry.resolvedType = type;
      entry.oid = oid;
      return { type, data: entry.data, oid };
    } finally {
      resolving.delete(entry.offset);
    }
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = TYPE_NUMBERS[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Deflate level for pack objects: 6 is git's default; speed matters more here, so 1 is used for bulk packs. */
export function writePack(objects: Iterable<GitObject>, level = 1): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Collect every object reachable from `tips` (following commit parents and tree
 * entries), minus anything reachable from `haves`. Returns the objects in a stable
 * order: commits newest-first by discovery, then trees, then blobs — any order is
 * valid for a pack, but a stable order keeps the bytes deterministic.
 */
export function collectReachable(
  lookup: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  haves: readonly string[] = [],
): Map<string, GitObject> {
  const haveReachable = new Set<string>();
  const markHave = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || haveReachable.has(cur)) continue;
      haveReachable.add(cur);
      const obj = lookup(cur);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        if (view.tree) stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
        if (m) stack.push(m[1] ?? '');
      }
    }
  };
  for (const have of haves) markHave(have);

  const out = new Map<string, GitObject>();
  const stack = [...tips];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || oid === ZERO_OID || seen.has(oid) || haveReachable.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      if (view.tree) stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) stack.push(m[1] ?? '');
    }
  }
  return out;
}
