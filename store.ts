// store.ts — the forge's in-memory data model.
//
// One Store holds every user, repository, object, ref, issue, pull request, label and
// comment. Everything is deterministic: a logical clock (fixed epoch plus a monotonic
// sequence) supplies every timestamp and every author/committer date, so two runs on
// the same inputs produce the same state. No Date.now(), no Math.random() anywhere
// in entry behaviour.
//
// Identity (from the public contest scenario, wire.ts buildScenario, seed 0x6a09e667):
//   viewer   adaiversen  (id 1000)  — the token owner
//   teammate quinnkeller (id 1001)
//   stranger olgabauer   (id 1002)
//   org      faint-meadow-org
// Repositories are created on demand through POST /user/repos; the store starts empty
// (the checks create every repository they use). Numeric repository ids start at 5000,
// continuing the scenario's block, so a created repo's databaseId never collides with
// a seeded one.

import { hashObject, buildTree, buildCommit, parseTree, parseCommit, ZERO_OID } from './gitobj.ts';
import type { GitObject, GitObjectType, TreeEntry } from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';
export const ORG_LOGIN = 'faint-meadow-org';
export const DEFAULT_BRANCH = 'main';

/** Scenario epoch: 2025-01-01T00:00:00Z. The logical clock starts here and ticks one second per event. */
export const EPOCH_MS = Date.UTC(2025, 0, 1, 0, 0, 0);

export interface User {
  login: string;
  id: number;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export const VIEWER: User = { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' };
export const TEAMMATE: User = { login: TEAMMATE_LOGIN, id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER: User = { login: STRANGER_LOGIN, id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG: User = { login: ORG_LOGIN, id: 1003, name: 'faint meadow org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: User;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  /** Cached serialised REST JSON; cleared on any change. */
  jsonCache: string | null;
  /** Cached UTF-8 bytes of jsonCache; cleared on any change. */
  jsonBuf: Buffer | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: User;
  created_at: string;
  updated_at: string;
  /** Cached file list for GET /pulls/{n}/files; cleared when either tip moves. */
  filesCache: PullFile[] | null;
}

export interface FetchPlan {
  /** Pack bytes, or null when nothing new is sent. */
  pack: Buffer | null;
  shallow: string[];
  unshallow: string[];
}

export interface Repo {
  id: number;
  name: string;
  owner: User;
  private: boolean;
  description: string;
  default_branch: string;
  has_issues: boolean;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  nextCommentId: number;
  labels: Map<string, Label>;
  nextLabelId: number;
  pulls: Map<number, PullRequest>;
  nextPullNumber: number;
  /** Cached fetch plans keyed by the pack request fingerprint. */
  lastFetchV2: { request: Buffer; response: Buffer; objectCount: number } | null;
  packCache: Map<string, FetchPlan>;
  /** Cached info/refs advertisements; the v0 ones carry the tip-OID offsets so a
   *  tip change patches a copy instead of rebuilding (see githttp.ts). The v2
   *  advertisement holds capabilities only and never depends on refs. */
  advV2: Buffer | null;
  advV0Upload: AdvV0 | null;
  advV0Receive: AdvV0 | null;
  /** Cached ls-refs responses keyed by the argument signature. */
  lsRefsCache: Map<string, Buffer>;
}

/** A cached v0 advertisement: bytes, the byte offsets of the tip OID inside them
 *  (the HEAD line and the default-branch line — the only lines a tip change moves),
 *  and the ref-set key they were built for. */
export interface AdvV0 {
  buf: Buffer;
  tipOffsets: number[];
  refKey: string;
}

/** Opaque global ids: base64url of a typed payload, never the bare numeric id. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  const payload = `${kind}:${parts.join(':')}`;
  return `${kind[0].toUpperCase()}_` + Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode a global id produced by globalId; returns null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  const m = /^([A-Z])_([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  let payload: string;
  try {
    payload = Buffer.from(m[2] ?? '', 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const colon = payload.indexOf(':');
  if (colon < 0) return null;
  const kind = payload.slice(0, colon);
  if (kind.length === 0 || kind[0]?.toUpperCase() !== m[1]) return null;
  return { kind, parts: payload.slice(colon + 1).split(':') };
}

export class Store {
  /** Keyed by `${owner}/${name}` (both lower-cased). */
  repos = new Map<string, Repo>();
  /** Keyed by numeric id. */
  reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  /** Logical clock: seconds since EPOCH_MS. */
  private seq = 0;
  /** Counters for ids that must be unique across the whole store. */
  private nextCommentSeq = 1;

  /** Advance the logical clock and return the new ISO-8601 timestamp. */
  tick(): string {
    this.seq += 1;
    return new Date(EPOCH_MS + this.seq * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** Current logical time without advancing it. */
  now(): string {
    return new Date(EPOCH_MS + this.seq * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The git author/committer line for the viewer at the current logical time. */
  ident(): string {
    const epochSeconds = Math.floor(EPOCH_MS / 1000) + this.seq;
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSeconds} +0000`;
  }

  createRepo(owner: User, name: string, opts: { private?: boolean; description?: string; default_branch?: string } = {}): Repo {
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      name,
      owner,
      private: opts.private ?? false,
      description: opts.description ?? '',
      default_branch: opts.default_branch ?? DEFAULT_BRANCH,
      has_issues: true,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      nextCommentId: 1,
      labels: new Map(),
      nextLabelId: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      lastFetchV2: null,
      packCache: new Map(),
      advV2: null,
      advV0Upload: null,
      advV0Receive: null,
      lsRefsCache: new Map(),
    };
    this.repos.set(repoKey(owner.login, name), repo);
    this.reposById.set(id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repoKey(repo.owner.login, repo.name));
    this.reposById.delete(repo.id);
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  /** All repositories owned by `login`, in creation order. */
  reposOf(login: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.login.toLowerCase() === login.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq || a.id - b.id);
    return out;
  }

  /** Invalidate every cache that depends on the repo's refs. The v0 advertisements
   *  are NOT cleared: their ref-set key (githttp.ts) detects a structural ref
   *  change and rebuilds, while a plain tip change patches the cached bytes in a
   *  copy. The v2 advertisement holds capabilities only and never depends on refs. */
  bumpRefs(repo: Repo): void {
    repo.lastFetchV2 = null;
    repo.packCache.clear();
    repo.lsRefsCache.clear();
  }

  /** Store an object, returning its oid. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name (short branch name, full ref, or oid) to an oid, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/i.test(ref)) return repo.objects.has(ref.toLowerCase()) ? ref.toLowerCase() : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const direct = repo.refs.get(`refs/heads/${ref}`);
    if (direct !== undefined) return direct;
    return repo.refs.get(`refs/tags/${ref}`);
  }

  /** The oid the default branch points at, or undefined for an unborn repository. */
  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.default_branch}`);
  }

  /** All branches as {name, sha}, default branch first, then the rest sorted by name. */
  branches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => {
      if (a.name === repo.default_branch) return -1;
      if (b.name === repo.default_branch) return 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  /** Every commit reachable from `tip`, newest-first by discovery order (parents after children). */
  commitsFrom(repo: Repo, tip: string, limit = 1000): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
    const out: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const sha = stack.pop();
      if (sha === undefined || sha === ZERO_OID || seen.has(sha)) continue;
      seen.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      out.push({ sha, commit: view });
      for (const parent of view.parents) stack.push(parent);
    }
    return out;
  }

  /** The tree oid of a commit, or undefined. */
  commitTree(repo: Repo, sha: string): string | undefined {
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  /**
   * Flatten a tree into path -> {oid, mode}. Follows subtrees recursively.
   * Directories themselves are not entries in the map.
   */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Build (and store) the tree for a complete path -> blob map. `files` must hold
   * every file in the resulting tree (callers pass a full flattened map); untouched
   * subtrees are rebuilt from their file lists, so the result is exact.
   */
  buildTreeFromMap(repo: Repo, baseTreeOid: string | undefined, files: Map<string, { oid: string; mode: string }>): string {
    const build = (dirFiles: Map<string, { oid: string; mode: string }>): string => {
      const byName = new Map<string, TreeEntry>();
      const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, file] of dirFiles) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          byName.set(path, { mode: file.mode, name: path, oid: file.oid });
        } else {
          const dir = path.slice(0, slash);
          let sub = subdirs.get(dir);
          if (!sub) {
            sub = new Map();
            subdirs.set(dir, sub);
          }
          sub.set(path.slice(slash + 1), file);
        }
      }
      for (const [dir, sub] of subdirs) {
        const subOid = build(sub);
        byName.set(dir, { mode: '40000', name: dir, oid: subOid });
      }
      const data = buildTree([...byName.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return build(files);
  }

  /** Delete a path from a tree, returning the new root tree oid. */
  deleteFromTree(repo: Repo, baseTreeOid: string, path: string): string | null {
    const flat = this.flattenTree(repo, baseTreeOid);
    if (!flat.has(path)) return null;
    flat.delete(path);
    return this.buildTreeFromMap(repo, baseTreeOid, flat);
  }

  /** Create a commit on top of `parent` (or root) with the given tree. Returns the commit oid. */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree: treeOid,
      parents,
      author: this.ident(),
      committer: this.ident(),
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject(repo, 'commit', data);
  }

  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing) return existing;
    const label: Label = { id: repo.nextLabelId++, name, color: color.replace(/^#/, ''), description };
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name.toLowerCase());
      if (label) labels.push(label);
    }
    const now = this.tick();
    const issue: Issue = {
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      comments: [],
      jsonCache: null,
      jsonBuf: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = this.tick();
    const comment: Comment = { id: repo.nextCommentId++, body, user: VIEWER, created_at: now, updated_at: now };
    issue.comments.push(comment);
    issue.jsonCache = null; issue.jsonBuf = null;
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): PullRequest {
    const now = this.tick();
    const pr: PullRequest = {
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      user: VIEWER,
      created_at: now,
      updated_at: now,
      filesCache: null,
    };
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /**
   * Three-way tree merge for a squash merge. Returns the merged tree oid, or null
   * when both sides changed the same path differently (a conflict).
   */
  mergeTrees(repo: Repo, baseOid: string, headOid: string, tipOid: string): string | null {
    if (this.hasMergeConflict(repo, baseOid, headOid, tipOid)) return null;
    const base = this.flattenTree(repo, baseOid);
    const head = this.flattenTree(repo, headOid);
    const tip = this.flattenTree(repo, tipOid);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      if (sameFile(h, t)) {
        if (h) merged.set(path, h);
      } else if (sameFile(b, h)) {
        if (t) merged.set(path, t);
      } else if (sameFile(b, t)) {
        if (h) merged.set(path, h);
      }
    }
    return this.buildTreeFromMap(repo, baseOid, merged);
  }

  /** Pure three-way conflict check: true when both sides changed the same path differently. Creates no objects. */
  hasMergeConflict(repo: Repo, baseOid: string, headOid: string, tipOid: string): boolean {
    const base = this.flattenTree(repo, baseOid);
    const head = this.flattenTree(repo, headOid);
    const tip = this.flattenTree(repo, tipOid);
    const paths = new Set<string>([...base.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const b = base.get(path);
      const h = head.get(path);
      const t = tip.get(path);
      if (sameFile(h, t) || sameFile(b, h) || sameFile(b, t)) continue;
      return true;
    }
    return false;
  }

  /** Diff two trees; returns per-file changes with line counts. */
  diffTrees(repo: Repo, baseOid: string | undefined, headOid: string): PullFile[] {
    const base = baseOid ? this.flattenTree(repo, baseOid) : new Map<string, { oid: string; mode: string }>();
    const head = this.flattenTree(repo, headOid);
    const files: PullFile[] = [];
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      if (!b && h) {
        const content = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        files.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (b && !h) {
        const content = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const lines = countLines(content);
        files.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (b && h) {
        const oldContent = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
        const newContent = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
        const { additions, deletions } = lineDiff(oldContent, newContent);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** The merge base of two commits (first common ancestor), or undefined. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const sha = stackA.pop();
      if (sha === undefined || sha === ZERO_OID || ancestorsA.has(sha)) continue;
      ancestorsA.add(sha);
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const sha = stackB.pop();
      if (sha === undefined || sha === ZERO_OID || seenB.has(sha)) continue;
      seenB.add(sha);
      if (ancestorsA.has(sha)) return sha;
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
    }
    return undefined;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

function sameFile(a: { oid: string; mode: string } | undefined, b: { oid: string; mode: string } | undefined): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) count += 1;
  if (buf[buf.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Simple line diff (LCS via DP for small files, whole-file fallback for large ones). */
export function lineDiff(oldBuf: Buffer, newBuf: Buffer): { additions: number; deletions: number } {
  const oldLines = splitLines(oldBuf);
  const newLines = splitLines(newBuf);
  if (oldLines.length * newLines.length > 250_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  // LCS lengths, one row at a time from the end.
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      curr[j] = oldLines[i] === newLines[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  const lcs = prev[0];
  return { additions: n - lcs, deletions: m - lcs };
}

function splitLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
