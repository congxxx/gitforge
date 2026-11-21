// githttp.ts — git smart-HTTP: info/refs advertisements, upload-pack (v2 + v0),
// receive-pack (v0) and the pack building that backs fetches.
//
// The framing follows the suite's own git client (program/env/src/git-client.ts):
//   v2 advertisement: "# service=git-upload-pack" + flush, then "version 2" and
//     capability lines ("ls-refs=unborn peel symrefs ref-prefix", "fetch=shallow filter",
//     "object-format=sha1", "server-option").
//   v0 advertisement: "# service=..." + flush, then "<oid> SP <ref>\0<caps>" on the first
//     line, peeled "<oid> SP <ref>^{}" lines for annotated tags, zero-OID HEAD when unborn.
//   v2 fetch response: "acknowledgments" (NAK / ACK + ready), "shallow-info" (shallow /
//     unshallow, only for depth fetches), "packfile" (sideband band-1 pack data), each
//     section closed by a delim, the stream by a flush.
//   v0 fetch response: NAK / ACK lines, shallow lines, then sideband pack packets, flush.
//   receive-pack response: report-status inside sideband band 1 ("unpack ok", "ok <ref>",
//     "ng <ref> <reason>"), then flush.
// The server never sends deltas; every pack is full objects, which the client accepts.
// Packs are cached per (repo, wants, haves, depth, shallow boundaries): the 50-way
// concurrent shallow clone workload fetches the same pack fifty times.

import { pktLine, pktFlush, pktDelim, decodePktLines, encodePktLines, writePack, readPack, parseCommit, parseTree, ZERO_OID, hashObject } from './gitobj.ts';
import type { GitObject } from './gitobj.ts';
import { Store, VIEWER_LOGIN } from './store.ts';
import type { AdvV0, Repo, FetchPlan } from './store.ts';

export interface GitResult {
  status: number;
  body: Buffer | null;
  contentType: string;
}

const AGENT = 'gitforge/1.0';

const ok = (body: Buffer, contentType: string): GitResult => ({ status: 200, body, contentType });
const notFound = (): GitResult => ({ status: 404, body: Buffer.from('{"message":"Not Found"}', 'utf8'), contentType: 'application/json' });

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

// ---------------------------------------------------------------- refs

interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then heads and tags sorted by name. */
function listRefs(store: Store, repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const tip = store.defaultTip(repo);
  const headTarget = `refs/heads/${repo.default_branch}`;
  if (tip) out.push({ oid: tip, name: 'HEAD', symrefTarget: headTarget });
  else out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  const refs: ListedRef[] = [];
  for (const [ref, oid] of repo.refs) {
    const entry: ListedRef = { oid, name: ref };
    const obj = repo.objects.get(oid);
    if (ref.startsWith('refs/tags/') && obj && obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) entry.peeled = m[1];
    }
    refs.push(entry);
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  out.push(...refs);
  return out;
}

function uploadPackCapsV0(repo: Repo): string {
  return `side-band-64k shallow multi_ack thin-pack ofs-delta symref=HEAD:refs/heads/${repo.default_branch} agent=${AGENT}`;
}

function receivePackCapsV0(repo: Repo): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

// ---------------------------------------------------------------- info/refs

/**
 * The ref-set key a cached v0 advertisement was built for: the default branch plus
 * every ref EXCEPT the default branch (name and oid). A tip change leaves the key
 * alone, so the cached bytes are patched; any other ref change — a new branch, a
 * deleted ref, a moved tag — changes the key and rebuilds. Tag targets ride along
 * because a tag ref's oid is in the key (a moved tag changes it, and its peeled
 * line is rebuilt with it).
 */
function v0RefKey(repo: Repo): string {
  const main = `refs/heads/${repo.default_branch}`;
  const others: string[] = [];
  for (const [name, oid] of repo.refs) {
    if (name !== main) others.push(`${name}=${oid}`);
  }
  others.sort();
  // The default branch's EXISTENCE is part of the key (its oid is not): an
  // unborn repo's cached advertisement has no main line at all, so the first
  // push that creates the branch must rebuild rather than patch.
  return `${repo.default_branch}|${repo.refs.has(main) ? 'main' : ''}|${others.join(',')}`;
}

/** A cached v0 advertisement patched with the current tip (on a copy, so a
 *  response already handed to the socket is never mutated). */
function patchedV0(cached: AdvV0, tip: string): Buffer {
  const out = Buffer.from(cached.buf);
  for (const off of cached.tipOffsets) out.write(tip, off, 'ascii');
  return out;
}

export function handleInfoRefs(store: Store, owner: string, name: string, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | null): GitResult {
  const repo = lookupRepo(store, owner, name);
  if (!repo) return notFound();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol !== null && gitProtocol.includes('version=2')) {
    if (repo.advV2 === null) {
      const lines: Array<string | 'flush'> = [
        `# service=git-upload-pack\n`,
        'flush',
        'version 2\n',
        `agent=${AGENT}\n`,
        'ls-refs=unborn peel symrefs ref-prefix\n',
        'fetch=shallow filter\n',
        'object-format=sha1\n',
        'server-option\n',
        'flush',
      ];
      repo.advV2 = encodePktLines(lines);
    }
    return ok(repo.advV2, contentType);
  }
  // v0: patch the cached bytes when the ref set is unchanged, rebuild otherwise.
  const cached = service === 'git-upload-pack' ? repo.advV0Upload : repo.advV0Receive;
  const refKey = v0RefKey(repo);
  if (cached !== null && cached.refKey === refKey) {
    const tip = store.defaultTip(repo) ?? ZERO_OID;
    return ok(patchedV0(cached, tip), contentType);
  }
  const refs = listRefs(store, repo);
  const caps = service === 'git-upload-pack' ? uploadPackCapsV0(repo) : receivePackCapsV0(repo);
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      lines.push(line);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  const body = encodePktLines(lines);
  // Record where the tip OID sits: the HEAD line and the default-branch line are
  // the only lines a tip change moves. Any other ref at the same commit keeps its
  // own OID, so it must NOT be patched — match those two lines exactly.
  const tip = store.defaultTip(repo) ?? ZERO_OID;
  const tipOffsets: number[] = [];
  {
    let off = 0;
    const branch = repo.default_branch;
    for (const line of lines) {
      if (line === 'flush') {
        off += 4;
        continue;
      }
      if (line.startsWith(`${tip} HEAD\0`) || line === `${tip} refs/heads/${branch}\n`) tipOffsets.push(off + 4);
      off += 4 + Buffer.byteLength(line, 'utf8');
    }
  }
  const adv: AdvV0 = { buf: body, tipOffsets, refKey };
  if (service === 'git-upload-pack') repo.advV0Upload = adv;
  else repo.advV0Receive = adv;
  return ok(body, contentType);
}

// ---------------------------------------------------------------- fetch planning

/** The objects a shallow client already holds for one have: the commit, its tree and blobs — not its parents. */
function shallowHaveObjects(store: Store, repo: Repo, oid: string): Set<string> {
  const out = new Set<string>([oid]);
  const tree = store.commitTree(repo, oid);
  if (tree) {
    out.add(tree);
    for (const { oid: blobOid } of store.flattenTree(repo, tree).values()) out.add(blobOid);
    // Also the subtree objects themselves.
    const collectTrees = (treeOid: string): void => {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') {
          out.add(entry.oid);
          collectTrees(entry.oid);
        }
      }
    };
    collectTrees(tree);
  }
  return out;
}

/** Full closure reachable from `oid` (commits, trees, blobs, tags). */
function fullReachable(store: Store, repo: Repo, oid: string): Set<string> {
  const out = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || cur === ZERO_OID || out.has(cur)) continue;
    out.add(cur);
    const obj = repo.objects.get(cur);
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
  return out;
}

/**
 * Plan a fetch: which objects to send, and the shallow-info lines.
 * `depth` is null for a full fetch. `shallowBoundaries` are the client's existing
 * shallow boundary commits (from its `shallow` request lines).
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[],
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  const haveObjects = new Set<string>();
  const haveCommits = new Set<string>();
  for (const have of haves) {
    haveCommits.add(have);
    const owned = boundarySet.has(have) ? shallowHaveObjects(store, repo, have) : fullReachable(store, repo, have);
    for (const oid of owned) haveObjects.add(oid);
  }

  // BFS over commits from the wants, honouring the depth limit.
  const included = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  const queued = new Set<string>(wants);
  while (queue.length > 0) {
    const [oid, dist] = queue.shift() as [string, number];
    const isHave = haveCommits.has(oid);
    const withinDepth = depth === null || dist < depth;
    if (!isHave && withinDepth) included.set(oid, dist);
    // Traverse to parents when: no depth limit and this is not a have (a have's
    // history is already held), or a depth limit still allows another generation
    // (deepening goes through a held shallow boundary).
    const canDescend = depth === null ? !isHave : dist + 1 < depth;
    if (!canDescend) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ZERO_OID || queued.has(parent)) continue;
      queued.add(parent);
      queue.push([parent, dist + 1]);
    }
  }

  // Objects: included commits, their trees and blobs, minus anything the client holds.
  const objects = new Map<string, GitObject>();
  for (const oid of included.keys()) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (!haveObjects.has(oid)) objects.set(oid, obj);
    if (obj.type !== 'commit') continue;
    const tree = parseCommit(obj.data).tree;
    if (!tree) continue;
    const collect = (treeOid: string): void => {
      const treeObj = repo.objects.get(treeOid);
      if (!treeObj || treeObj.type !== 'tree') return;
      if (!haveObjects.has(treeOid)) objects.set(treeOid, treeObj);
      for (const entry of parseTree(treeObj.data)) {
        if (entry.mode === '40000') collect(entry.oid);
        else {
          const blob = repo.objects.get(entry.oid);
          if (blob && !haveObjects.has(entry.oid)) objects.set(entry.oid, blob);
        }
      }
    };
    collect(tree);
  }

  let pack: Buffer | null = null;
  if (objects.size > 0) pack = writePack(objects.values(), 1);

  // Shallow-info, only for depth fetches.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null || shallowBoundaries.length > 0) {
    for (const oid of included.keys()) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const boundary = parents.length === 0 || parents.some((p) => !included.has(p));
      if (boundary) shallow.push(oid);
    }
    for (const boundary of shallowBoundaries) {
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => included.has(p))) unshallow.push(boundary);
    }
  }
  return { pack, shallow, unshallow };
}

/** Sideband-wrap a pack into pkt-lines (band 1), chunked to the 64k sideband limit. */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

/** A sideband band-3 error packet. */
function sidebandError(message: string): Buffer {
  return pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(message, 'utf8')]));
}

// ---------------------------------------------------------------- upload-pack

interface V2FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function parseV2Args(packets: ReturnType<typeof decodePktLines>): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

function handleLsRefs(store: Store, repo: Repo, args: readonly string[]): Buffer {
  const cacheKey = args.join('|');
  const cached = repo.lsRefsCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const refs = listRefs(store, repo);
  const lines: Array<string | 'flush'> = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    if (ref.unborn && !unborn) continue;
    if (ref.unborn) {
      let line = `unborn ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      lines.push(`${line}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  const body = encodePktLines(lines);
  if (repo.lsRefsCache.size > 16) repo.lsRefsCache.clear();
  repo.lsRefsCache.set(cacheKey, body);
  return body;
}

function handleFetchV2(store: Store, repo: Repo, args: readonly string[], body: Buffer): Buffer {
  const req: V2FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) req.depth = n;
    } else if (arg.startsWith('filter ')) req.filter = arg.slice(7);
  }
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of req.haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  const ackLines: Array<string | 'delim'> = ['acknowledgments\n'];
  if (acks.length > 0) {
    for (const ack of acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('delim');
  parts.push(encodePktLines(ackLines));

  const missing = req.wants.filter((w) => !repo.objects.has(w));
  if (missing.length > 0) {
    parts.push(encodePktLines(['packfile\n' as string, sidebandError(`ERR upload-pack: not our ref ${missing[0]}\n`), 'delim', 'flush']));
    return Buffer.concat(parts);
  }
  const cacheKey = `${repo.id}|${[...req.wants].sort().join(',')}|${[...req.haves].sort().join(',')}|${req.depth ?? ''}|${[...req.shallow].sort().join(',')}`;
  let plan = repo.packCache.get(cacheKey);
  if (plan === undefined) {
    plan = planFetch(store, repo, req.wants, req.haves, req.depth, req.shallow);
    if (repo.packCache.size > 64) {
      const first = repo.packCache.keys().next().value;
      if (first !== undefined) repo.packCache.delete(first);
    }
    repo.packCache.set(cacheKey, plan);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (plan.pack !== null) {
    parts.push(encodePktLines(['packfile\n']));
    for (const chunk of sidebandPack(plan.pack)) parts.push(chunk);
    parts.push(pktDelim());
  }
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  if (body.length <= 4096 && response.length <= 1024 * 1024) {
    repo.lastFetchV2 = { request: Buffer.from(body), response, objectCount: repo.objects.size };
  }
  return response;
}

function handleFetchV0(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0] ?? '';
      if (/^[0-9a-f]{40}$/.test(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  const missing = wants.filter((w) => !repo.objects.has(w));
  if (missing.length > 0) {
    parts.push(sidebandError(`ERR upload-pack: not our ref ${missing[0]}\n`));
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  const cacheKey = `v0|${repo.id}|${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...shallow].sort().join(',')}`;
  let plan = repo.packCache.get(cacheKey);
  if (plan === undefined) {
    plan = planFetch(store, repo, wants, haves, depth, shallow);
    if (repo.packCache.size > 64) {
      const first = repo.packCache.keys().next().value;
      if (first !== undefined) repo.packCache.delete(first);
    }
    repo.packCache.set(cacheKey, plan);
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.pack !== null) {
    for (const chunk of sidebandPack(plan.pack)) parts.push(chunk);
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleUploadPack(store: Store, owner: string, name: string, body: Buffer, gitProtocol: string | null): GitResult {
  const repo = lookupRepo(store, owner, name);
  if (!repo) return notFound();
  const cached = repo.lastFetchV2;
  if (cached && cached.objectCount === repo.objects.size && cached.request.equals(body)) {
    return ok(cached.response, 'application/x-git-upload-pack-result');
  }
  let packets: ReturnType<typeof decodePktLines>;
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, body: Buffer.from('{"message":"Bad Request"}', 'utf8'), contentType: 'application/json' };
  }
  const firstData = packets.find((p) => p.kind === 'data');
  const firstLine = firstData?.payload.toString('utf8') ?? '';
  if (firstLine.startsWith('command=')) {
    const { command, args } = parseV2Args(packets);
    if (command === 'ls-refs') {
      return ok(handleLsRefs(store, repo, args), 'application/x-git-upload-pack-result');
    }
    if (command === 'fetch') {
      return ok(handleFetchV2(store, repo, args, body), 'application/x-git-upload-pack-result');
    }
    return { status: 400, body: Buffer.from('{"message":"Bad Request"}', 'utf8'), contentType: 'application/json' };
  }
  return ok(handleFetchV0(store, repo, packets), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Whether `descendant` is `ancestor` itself or has `ancestor` in its parent chain. */
function isDescendantOrEqual(store: Store, repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined || cur === ZERO_OID || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === ancestor) return true;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResult {
  const repo = lookupRepo(store, owner, name);
  if (!repo) return notFound();
  // Split the body at the first flush packet: everything before it is the command
  // list, everything after it is the pack. Scan pkt-line lengths by hand so the
  // raw pack bytes are never parsed as pkt-lines.
  let commands: PushCommand[] = [];
  let packStart = body.length;
  let malformed = false;
  {
    let off = 0;
    while (off + 4 <= body.length) {
      const lenHex = body.subarray(off, off + 4).toString('ascii');
      const len = parseInt(lenHex, 16);
      if (Number.isNaN(len) || len < 0 || len > 65520) {
        malformed = true;
        break;
      }
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      if (off + len > body.length) {
        malformed = true;
        break;
      }
      if (len > 4) {
        const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
        const nul = line.indexOf('\0');
        const head = nul >= 0 ? line.slice(0, nul) : line;
        const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head.trim());
        if (m) commands.push({ oldOid: m[1] ?? '', newOid: m[2] ?? '', ref: m[3] ?? '' });
      }
      off += len;
    }
    if (off + 4 > body.length && packStart === body.length && commands.length === 0) malformed = true;
  }
  if (malformed) {
    const inner = encodePktLines(['unpack bad request\n', 'flush']);
    return ok(Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]), 'application/x-git-receive-pack-result');
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = readPack(packBytes);
        for (const [oid, obj] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = `unpacker error: ${(e as Error).message}`;
      }
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isDescendantOrEqual(store, repo, command.newOid, current)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
    store.bumpRefs(repo);
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
  }

  const innerLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    innerLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = encodePktLines(innerLines);
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]);
  return ok(outer, 'application/x-git-receive-pack-result');
}
