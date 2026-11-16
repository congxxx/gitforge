// rest.ts — GitHub REST API v3 handlers.
//
// Every handler returns { status, body, headers? } where body is a pre-serialised
// JSON string (or null for a 204). The router in app.ts does auth, JSON parsing and
// the response envelope; this module only implements endpoint semantics.
//
// Shapes follow what the suite's checks assert (program/env/src/checks-rest.ts):
//   issue: {number, title, body, state, labels:[{name, color}]}
//   pull:  {number, state, title, body, head:{ref, sha}, base:{ref, sha},
//           merged, merged_at, merge_commit_sha}
//   content PUT: {content:{sha, encoding:"base64"}, commit:{sha}}
//   content GET: {type:"file", encoding:"base64", content, sha, size}
// Errors are always {message: string} (never HTML), 401/404/409/422 as asserted.

import { parseCommit, parseTree, ZERO_OID } from './gitobj.ts';
import { Store, VIEWER, VIEWER_LOGIN, globalId } from './store.ts';
import type { Repo, Issue, Comment, Label, PullRequest } from './store.ts';

export interface RestResult {
  status: number;
  body: string | Buffer | null;
  headers?: Record<string, string>;
}

export interface RouteParams {
  owner?: string;
  repo?: string;
  number?: number;
  path?: string;
  ref?: string;
}

const json = (status: number, value: unknown, headers?: Record<string, string>): RestResult => ({
  status,
  body: JSON.stringify(value),
  headers,
});

const err = (status: number, message: string): RestResult => json(status, { message });

const notFound = (what = 'Not Found'): RestResult => err(404, what);

// ---------------------------------------------------------------- serializers

export function userJson(user: { login: string; id: number; type: string }): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('user', user.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: user.type,
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: `${repo.owner.login}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: repo.has_issues,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: globalId('label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(repo: Repo, issue: Issue): string {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const body = JSON.stringify({
    id: repo.id * 1_000_000 + issue.number,
    node_id: globalId('issue', repo.id, issue.number),
    url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    state: issue.state,
    locked: false,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
  });
  issue.jsonCache = body;
  issue.jsonBuf = Buffer.from(body, 'utf8');
  return body;
}

/** Cached UTF-8 bytes of an issue's REST JSON (read/write workload fast path). */
export function issueBuffer(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonBuf === null) {
    const body = issueJson(repo, issue);
    issue.jsonBuf = Buffer.from(body, 'utf8');
  }
  return issue.jsonBuf;
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', repo.id, issue.number, comment.id),
    url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headRepo = repoJson(repo);
  return {
    id: repo.id * 1_000_000 + pr.number,
    node_id: globalId('pull', repo.id, pr.number),
    url: `https://api.github.com/repos/${repo.owner.login}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner.login}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body ?? '',
    user: userJson(pr.user),
    labels: [],
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.state === 'closed' ? pr.updated_at : null,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    merged: pr.merged,
    mergeable: pr.state === 'open' ? computeMergeable(store, repo, pr) : null,
    mergeable_state: pr.state === 'open' ? (computeMergeable(store, repo, pr) ? 'clean' : 'dirty') : 'unknown',
    merged_by: pr.merged ? userJson(VIEWER) : null,
    head: { label: `${repo.owner.login}:${pr.headRef}`, ref: pr.headRef, sha: pr.headSha, user: userJson(repo.owner), repo: headRepo },
    base: { label: `${repo.owner.login}:${pr.baseRef}`, ref: pr.baseRef, sha: pr.baseSha, user: userJson(repo.owner), repo: headRepo },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function computeMergeable(store: Store, repo: Repo, pr: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return false;
  const headTree = store.commitTree(repo, pr.headSha);
  const tipTree = store.commitTree(repo, baseTip);
  if (!headTree || !tipTree) return false;
  const base = store.mergeBase(repo, pr.headSha, baseTip);
  if (!base) return true;
  if (base === baseTip) return true;
  const baseTree = store.commitTree(repo, base);
  if (!baseTree) return true;
  return !store.hasMergeConflict(repo, baseTree, headTree, tipTree);
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const m = /^([^<]*)<([^>]*)>\s+(\d+)\s+([+-]\d{4})$/.exec(line.trim());
    if (!m) return { name: VIEWER_LOGIN, email: '', date: '2025-01-01T00:00:00Z' };
    return {
      name: (m[1] ?? '').trim(),
      email: m[2] ?? '',
      date: new Date(Number(m[3] ?? 0) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha,
    node_id: globalId('commit', sha),
    commit: {
      author: ident(view.author),
      committer: ident(view.committer),
      // The stored object ends its message with a newline; the API reports it without.
      message: view.message.replace(/\n+$/, ''),
      tree: { sha: view.tree, url: '' },
      comment_count: 0,
    },
    url: '',
    html_url: '',
    parents: view.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
  };
}

// ---------------------------------------------------------------- pagination

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], params: PageParams): { page: T[]; total: number; hasNext: boolean; hasPrev: boolean } {
  const total = items.length;
  const start = (params.page - 1) * params.perPage;
  return {
    page: items.slice(start, start + params.perPage),
    total,
    hasNext: start + params.perPage < total,
    hasPrev: params.page > 1,
  };
}

function linkHeader(base: string, query: URLSearchParams, params: PageParams, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / params.perPage));
  const build = (page: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(page));
    q.set('per_page', String(params.perPage));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (params.page < lastPage) parts.push(`${build(params.page + 1)}; rel="next"`);
  if (params.page > 1) parts.push(`${build(params.page - 1)}; rel="prev"`);
  parts.push(`${build(1)}; rel="first"`);
  parts.push(`${build(lastPage)}; rel="last"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- helpers

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== VIEWER_LOGIN) {
    // Repositories only ever exist under the viewer; any other owner is a 404,
    // never a 403 (the foreign-token check asserts exactly this).
    const repo = store.getRepo(owner, name);
    if (!repo) return null;
    return repo;
  }
  return store.getRepo(owner, name) ?? null;
}

function needRepo(store: Store, owner: string, name: string): Repo | RestResult {
  const repo = lookupRepo(store, owner, name);
  if (!repo) return notFound('Not Found');
  return repo;
}

function invalidBody(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

/** Resolve a ref query (?ref=) to a commit oid on `repo`. */
function resolveRefParam(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return store.defaultTip(repo);
  return store.resolveRef(repo, ref);
}

// ---------------------------------------------------------------- endpoints

export function handleRoot(): RestResult {
  return json(200, {
    current_user_url: 'https://api.github.com/user',
    current_user_authorizations_html_url: 'https://github.com/settings/applications',
    authorizations_url: 'https://api.github.com/authorizations',
    code_search_url: 'https://api.github.com/search/code?q={query}{&page,per_page}',
    commit_search_url: 'https://api.github.com/search/commits?q={query}{&page,per_page}',
    emails_url: 'https://api.github.com/user/emails',
    emojis_url: 'https://api.github.com/emojis',
    events_url: 'https://api.github.com/events',
    feeds_url: 'https://api.github.com/feeds',
    followers_url: 'https://api.github.com/users/{user}/followers',
    following_url: 'https://api.github.com/users/{user}/following{/target}',
    gists_url: 'https://api.github.com/gists{/gist_id}',
    hub_url: 'https://api.github.com/hub',
    issue_search_url: 'https://api.github.com/search/issues?q={query}{&page,per_page}',
    issues_url: 'https://api.github.com/issues',
    keys_url: 'https://api.github.com/user/keys',
    label_search_url: 'https://api.github.com/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
    notifications_url: 'https://api.github.com/notifications',
    organization_url: 'https://api.github.com/orgs/{org}',
    organization_repositories_url: 'https://api.github.com/orgs/{org}/repos{?type,page,per_page,sort}',
    organization_teams_url: 'https://api.github.com/orgs/{org}/teams',
    public_gists_url: 'https://api.github.com/gists/public',
    rate_limit_url: 'https://api.github.com/rate_limit',
    repository_url: 'https://api.github.com/repos/{owner}/{repo}',
    repository_search_url: 'https://api.github.com/search/repositories?q={query}{&page,per_page}',
    current_user_repositories_url: 'https://api.github.com/user/repos{?type,page,per_page,sort}',
    starred_url: 'https://api.github.com/user/starred{/owner}{/repo}',
    starred_gists_url: 'https://api.github.com/gists/starred',
    topic_search_url: 'https://api.github.com/search/topics?q={query}{&page,per_page}',
    user_url: 'https://api.github.com/users/{user}',
    user_organizations_url: 'https://api.github.com/user/orgs',
    user_repositories_url: 'https://api.github.com/users/{user}/repos{?type,page,per_page,sort}',
    user_search_url: 'https://api.github.com/search/users?q={query}{&page,per_page}',
  });
}

export function handleMeta(): RestResult {
  return json(200, { installed_version: '1.0.0' });
}

export function handleGetUser(): RestResult {
  return json(200, userJson(VIEWER));
}

export function handleCreateRepo(store: Store, body: unknown): RestResult {
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const name = bodyString(body, 'name');
  if (name === '') return err(422, 'Validation Failed: name is required');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'Validation Failed: name is invalid');
  if (store.getRepo(VIEWER_LOGIN, name)) return err(422, 'name already exists on this account');
  const repo = store.createRepo(VIEWER, name, {
    private: typeof body.private === 'boolean' ? body.private : false,
    description: bodyString(body, 'description'),
    default_branch: bodyString(body, 'default_branch') || undefined,
  });
  store.tick();
  return json(201, repoJson(repo));
}

export function handleListUserRepos(store: Store, query: URLSearchParams, base: string): RestResult {
  const params = pageParams(query);
  const repos = store.reposOf(VIEWER_LOGIN);
  const { page, total, hasNext } = paginate(repos, params);
  const headers: Record<string, string> = {};
  if (hasNext || params.page > 1) headers.Link = linkHeader(base, query, params, total);
  return json(200, page.map(repoJson), headers);
}

export function handleGetRepo(store: Store, owner: string, name: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  return json(200, repoJson(repo));
}

export function handlePatchRepo(store: Store, owner: string, name: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.has_issues === 'boolean') repo.has_issues = body.has_issues;
  if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
    if (store.getRepo(owner, body.name)) return err(422, 'name already exists on this account');
    store.repos.delete(`${owner.toLowerCase()}/${repo.name.toLowerCase()}`);
    repo.name = body.name;
    store.repos.set(`${owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
  }
  store.tick();
  return json(200, repoJson(repo));
}

export function handleDeleteRepo(store: Store, owner: string, name: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  store.deleteRepo(repo);
  return { status: 204, body: null };
}

export function handleListBranches(store: Store, owner: string, name: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  return json(
    200,
    store.branches(repo).map((b) => ({ name: b.name, commit: { sha: b.sha, url: '' }, protected: false })),
  );
}

export function handleCreateRef(store: Store, owner: string, name: string, body: unknown): RestResult {  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha').toLowerCase();
  if (!ref.startsWith('refs/')) return err(422, 'Validation Failed: ref must start with refs/');
  if (!/^[0-9a-f]{40}$/.test(sha)) return err(422, 'Validation Failed: sha is not a valid object id');
  if (!repo.objects.has(sha)) return err(422, 'Validation Failed: sha does not exist');
  if (repo.refs.has(ref)) return err(422, 'Validation Failed: ref already exists');
  repo.refs.set(ref, sha);
  store.bumpRefs(repo);
  store.tick();
  return json(201, { ref, node_id: globalId('ref', repo.id, ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
}

export function handleGetRef(store: Store, owner: string, name: string, ref: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const sha = repo.refs.get(ref);
  if (!sha) return notFound('Not Found');
  return json(200, { ref, node_id: globalId('ref', repo.id, ref), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
}

export function handleGetBranch(store: Store, owner: string, name: string, branch: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return notFound('Not Found');
  return json(200, { name: branch, commit: { sha, url: '' }, protected: false });
}

export function handleListCommits(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const shaParam = query.get('sha');
  const tip = shaParam !== null ? store.resolveRef(repo, shaParam) : store.defaultTip(repo);
  if (!tip) return json(200, []);
  const params = pageParams(query);
  const commits = store.commitsFrom(repo, tip, 1000);
  const { page } = paginate(commits, params);
  const out: Array<Record<string, unknown>> = [];
  for (const { sha } of page) {
    const entry = commitJson(repo, sha);
    if (entry) out.push(entry);
  }
  return json(200, out);
}

export function handleGetContent(store: Store, owner: string, name: string, path: string, query: URLSearchParams): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const tip = resolveRefParam(store, repo, query.get('ref'));
  if (!tip) return notFound('Not Found');
  const treeOid = store.commitTree(repo, tip);
  if (!treeOid) return notFound('Not Found');
  const flat = store.flattenTree(repo, treeOid);
  if (path === '' || path === '/') {
    // Root directory listing.
    const entries = listDirectory(repo, treeOid, '');
    return json(200, entries);
  }
  const file = flat.get(path);
  if (file) {
    const obj = repo.objects.get(file.oid);
    const data = obj?.data ?? Buffer.alloc(0);
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      content: data.toString('base64'),
      sha: file.oid,
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
    });
  }
  // Maybe a directory: collect direct children.
  const prefix = `${path}/`;
  const childNames = new Set<string>();
  let isDir = false;
  for (const key of flat.keys()) {
    if (key.startsWith(prefix)) {
      isDir = true;
      childNames.add(key.slice(prefix.length).split('/')[0] ?? '');
    }
  }
  if (!isDir) return notFound('Not Found');
  // Find the subtree oid for this directory.
  let dirOid: string | undefined;
  {
    let cur: string | undefined = treeOid;
    for (const segment of path.split('/')) {
      if (!cur) break;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') {
        cur = undefined;
        break;
      }
      const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
      cur = entry?.oid;
    }
    dirOid = cur;
  }
  if (!dirOid) return notFound('Not Found');
  return json(200, listDirectory(repo, dirOid, path));
}

function listDirectory(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parseTree(obj.data)) {
    const entryPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      out.push({ type: 'dir', size: 0, name: entry.name, path: entryPath, sha: entry.oid, url: '', html_url: '', git_url: '', download_url: null });
    } else {
      const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
      out.push({ type: 'file', size: data.length, name: entry.name, path: entryPath, sha: entry.oid, url: '', html_url: '', git_url: '', download_url: null });
    }
  }
  return out;
}

export function handlePutContent(store: Store, owner: string, name: string, path: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const message = bodyString(body, 'message');
  const contentB64 = bodyString(body, 'content');
  if (message === '' || contentB64 === '') return err(422, 'Validation Failed: message and content are required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    return err(422, 'Validation Failed: content is not valid base64');
  }
  const branch = bodyString(body, 'branch') || repo.default_branch;
  const refName = `refs/heads/${branch}`;
  const givenSha = bodyString(body, 'sha').toLowerCase();
  const tip = repo.refs.get(refName);
  const baseTree = tip ? store.commitTree(repo, tip) : undefined;
  const flat = baseTree ? store.flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  const isUpdate = existing !== undefined;
  if (givenSha !== '') {
    if (!isUpdate) return notFound('Not Found');
    if (givenSha !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current file');
  }
  const blobOid = store.putObject(repo, 'blob', content);
  flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = store.buildTreeFromMap(repo, baseTree, flat);
  const parents = tip ? [tip] : [];
  const commitOid = store.makeCommit(repo, treeOid, parents, message);
  repo.refs.set(refName, commitOid);
  store.bumpRefs(repo);
  store.tick();
  return json(isUpdate ? 200 : 201, {
    content: { name: path.slice(path.lastIndexOf('/') + 1), path, sha: blobOid, size: content.length, url: '', html_url: '', git_url: '', type: 'file', encoding: 'base64' },
    commit: { sha: commitOid, node_id: globalId('commit', commitOid), message, author: { name: 'ada iversen', email: 'adaiversen@example.invalid' }, committer: { name: 'ada iversen', email: 'adaiversen@example.invalid' }, parents: parents.map((p) => ({ sha: p })) },
  });
}

export function handleDeleteContent(store: Store, owner: string, name: string, path: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const branch = invalidBody(body) ? bodyString(body, 'branch') || repo.default_branch : repo.default_branch;
  const refName = `refs/heads/${branch}`;
  const givenSha = invalidBody(body) ? bodyString(body, 'sha').toLowerCase() : '';
  const tip = repo.refs.get(refName);
  if (!tip) return notFound('Not Found');
  const treeOid = store.commitTree(repo, tip);
  if (!treeOid) return notFound('Not Found');
  const flat = store.flattenTree(repo, treeOid);
  const existing = flat.get(path);
  if (!existing) return notFound('Not Found');
  if (givenSha !== '' && givenSha !== existing.oid.toLowerCase()) return err(409, 'Conflict: sha does not match the current file');
  const newTree = store.deleteFromTree(repo, treeOid, path);
  if (newTree === null) return notFound('Not Found');
  const message = invalidBody(body) ? bodyString(body, 'message') : '';
  const commitOid = store.makeCommit(repo, newTree, [tip], message === '' ? `Delete ${path}` : message);
  repo.refs.set(refName, commitOid);
  store.bumpRefs(repo);
  store.tick();
  return json(200, { commit: { sha: commitOid, message: message === '' ? `Delete ${path}` : message } });
}

export function handleListLabels(store: Store, owner: string, name: string): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  return json(200, [...repo.labels.values()].map(labelJson));
}

export function handleCreateLabel(store: Store, owner: string, name: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const labelName = bodyString(body, 'name');
  if (labelName === '') return err(422, 'Validation Failed: name is required');
  if (repo.labels.has(labelName.toLowerCase())) return err(422, 'Validation Failed: label already exists');
  const label = store.createLabel(repo, labelName, bodyString(body, 'color') || 'ededed', bodyString(body, 'description'));
  store.tick();
  return json(201, labelJson(label));
}

export function handleCreateIssue(store: Store, owner: string, name: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const title = bodyString(body, 'title');
  if (title === '') return err(422, 'Validation Failed: title is required');
  const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const labelName of labelNames) {
    if (!repo.labels.has(labelName.toLowerCase())) return err(422, `Validation Failed: label "${labelName}" does not exist`);
  }
  const issue = store.createIssue(repo, title, bodyString(body, 'body'), labelNames);
  return { status: 201, body: issueBuffer(repo, issue) };
}

export function handleListIssues(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  issues.sort((a, b) => {
    const cmp = sort === 'created' ? a.number - b.number : a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const params = pageParams(query);
  const { page } = paginate(issues, params);
  // Serialise each issue (cached per issue); lists are small in the checks.
  return { status: 200, body: `[${page.map((i) => issueJson(repo, i)).join(',')}]` };
}

export function handleGetIssue(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return { status: 200, body: issueBuffer(repo, issue) };
}

export function handlePatchIssue(store: Store, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labelNames = body.labels.filter((l): l is string => typeof l === 'string');
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName.toLowerCase())) return err(422, `Validation Failed: label "${labelName}" does not exist`);
    }
    issue.labels = labelNames.map((n) => repo.labels.get(n.toLowerCase()) as Label);
  }
  issue.updated_at = store.tick();
  issue.jsonCache = null; issue.jsonBuf = null;
  return { status: 200, body: issueJson(repo, issue) };
}

export function handleCreateComment(store: Store, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const text = bodyString(body, 'body');
  if (text === '') return err(422, 'Validation Failed: body is required');
  const comment = store.createComment(repo, issue, text);
  return json(201, commentJson(repo, issue, comment));
}

export function handleListComments(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
}

export function handleCreatePull(store: Store, owner: string, name: string, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  if (!invalidBody(body)) return err(422, 'Validation Failed');
  const title = bodyString(body, 'title');
  const headRaw = bodyString(body, 'head');
  const baseRaw = bodyString(body, 'base');
  if (title === '' || headRaw === '' || baseRaw === '') return err(422, 'Validation Failed: title, head and base are required');
  const headRef = headRaw.includes(':') ? (headRaw.split(':')[1] ?? headRaw) : headRaw;
  const baseRef = baseRaw.includes(':') ? (baseRaw.split(':')[1] ?? baseRaw) : baseRaw;
  const headSha = store.resolveRef(repo, headRef);
  const baseSha = store.resolveRef(repo, baseRef);
  if (!headSha || !baseSha) return err(422, 'Validation Failed: head or base ref does not exist');
  const pr = store.createPull(repo, title, bodyString(body, 'body'), headRef, headSha, baseRef, baseSha);
  return json(201, pullJson(store, repo, pr));
}

export function handleListPulls(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const params = pageParams(query);
  const { page } = paginate(pulls, params);
  return json(200, page.map((p) => pullJson(store, repo, p)));
}

export function handleGetPull(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  return json(200, pullJson(store, repo, pr));
}

export function handleListPullFiles(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  if (pr.filesCache === null) {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    const baseTree = baseTip ? store.commitTree(repo, baseTip) : undefined;
    // Diff against the merge base so the file list is the PR's own changes.
    const mergeBase = baseTip ? store.mergeBase(repo, pr.headSha, baseTip) : undefined;
    const baseForDiff = mergeBase ? store.commitTree(repo, mergeBase) : baseTree;
    const headTree = store.commitTree(repo, pr.headSha);
    pr.filesCache = headTree ? store.diffTrees(repo, baseForDiff, headTree) : [];
  }
  return json(
    200,
    pr.filesCache.map((f) => ({
      sha: '',
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    })),
  );
}

export function handleMergePull(store: Store, owner: string, name: string, number: number, body: unknown): RestResult {
  const repo = needRepo(store, owner, name);
  if ('status' in repo) return repo;
  const pr = repo.pulls.get(number);
  if (!pr) return notFound('Not Found');
  if (pr.state === 'closed') return err(405, 'Pull Request is already closed');
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return notFound('Not Found');
  const headTree = store.commitTree(repo, pr.headSha);
  const tipTree = store.commitTree(repo, baseTip);
  if (!headTree || !tipTree) return err(422, 'Validation Failed: cannot merge an empty pull request');
  const mergeBase = store.mergeBase(repo, pr.headSha, baseTip);
  const baseTree = mergeBase ? store.commitTree(repo, mergeBase) : undefined;
  // Fast-forward case: the head is a descendant of the base tip.
  let mergedTree: string | null;
  if (baseTree === undefined) {
    mergedTree = headTree;
  } else if (mergeBase === baseTip) {
    mergedTree = headTree;
  } else {
    mergedTree = store.mergeTrees(repo, baseTree, headTree, tipTree);
  }
  if (mergedTree === null) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
  const message = `${pr.title} (#${pr.number})`;
  const mergeSha = store.makeCommit(repo, mergedTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  store.bumpRefs(repo);
  pr.state = 'closed';
  pr.merged = true;
  pr.merged_at = store.tick();
  pr.updated_at = pr.merged_at;
  pr.merge_commit_sha = mergeSha;
  pr.filesCache = null;
  return json(200, { sha: mergeSha, merged: true, message });
}

// Unused import guard (ZERO_OID kept for callers that need the unborn marker).
export const __ZERO_OID = ZERO_OID;
