// mcp.ts — Model Context Protocol over streamable HTTP (plain JSON responses).
//
// Two protocol eras are served (program/env/src/checks-mcp.ts):
//   modern 2026-07-28: `server/discover` returns identity, capabilities and
//     supportedVersions; every request is stateless, no session.
//   legacy 2025-11-25 and earlier: `initialize` (echoing one of the offered
//     revisions) + `notifications/initialized`.
// The six required tools are github-mcp-server's names, with the documented argument
// contract (create_repo {name, description?, private?}; get_repo {owner, repo};
// create_issue {owner, repo, title, body?}; list_issues {owner, repo, state?};
// create_pull_request {owner, repo, title, head, base, body?};
// merge_pull_request {owner, repo, pull_number}). Every tool result is a text
// content block carrying the same JSON the REST surface returns, so MCP and REST
// are the same objects. The tools list is a constant, so two tools/list answers
// are byte-identical.
// Errors: unknown method -32601, unknown tool / missing arguments -32602, a body
// that is not JSON answers HTTP 400 with JSON-RPC -32700.

import { Store, VIEWER, VIEWER_LOGIN } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

export interface McpResult {
  status: number;
  body: string | null;
}

const SERVER_NAME = 'gitforge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'The repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: false };
}

function toolErrorText(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

export function handleMcp(store: Store, rawBody: string): McpResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  if (Array.isArray(body)) {
    const responses = body.map((item) => handleOne(store, item)).filter((r): r is string => r !== null);
    return { status: 200, body: `[${responses.join(',')}]` };
  }
  const response = handleOne(store, body);
  if (response === null) return { status: 202, body: null };
  return { status: 200, body: response };
}

/** Handle one JSON-RPC object; returns the response JSON string, or null for a notification. */
function handleOne(store: Store, request: unknown): string | null {
  if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const hasId = 'id' in request && (typeof request.id === 'string' || typeof request.id === 'number');
  const id: JsonRpcId = hasId ? (request.id as string | number) : null;
  const method = request.method as string;
  const params = isRecord(request.params) ? request.params : {};

  // Notifications (no id) are acknowledged with no response body.
  if (!hasId) {
    if (method.startsWith('notifications/')) return null;
    return rpcError(null, -32600, 'Invalid Request: a request needs an id');
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests and git smart HTTP.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      const result = runTool(store, toolName, args);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Run one tool; tool-level failures are isError results, not JSON-RPC errors. */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = argString(args, 'owner');
  const repoName = argString(args, 'repo');
  const lookupRepo = (): ReturnType<Store['getRepo']> => {
    if (owner !== '' && owner.toLowerCase() !== VIEWER_LOGIN) return undefined;
    return store.getRepo(owner === '' ? VIEWER_LOGIN : owner, repoName);
  };

  switch (name) {
    case 'create_repo': {
      const repoNameArg = argString(args, 'name');
      if (store.getRepo(VIEWER_LOGIN, repoNameArg)) return toolErrorText('name already exists on this account');
      const repo = store.createRepo(VIEWER, repoNameArg, {
        private: typeof args.private === 'boolean' ? args.private : false,
        description: argString(args, 'description'),
      });
      store.tick();
      return toolText(JSON.stringify(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      return toolText(JSON.stringify(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const title = argString(args, 'title');
      const body = argString(args, 'body');
      const issue = store.createIssue(repo, title, body, []);
      return toolText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const state = argString(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.number - a.number);
      return toolText(`[${issues.map((i) => issueJson(repo, i)).join(',')}]`);
    }
    case 'create_pull_request': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const title = argString(args, 'title');
      const body = argString(args, 'body');
      const headRef = argString(args, 'head');
      const baseRef = argString(args, 'base');
      const headSha = store.resolveRef(repo, headRef);
      const baseSha = store.resolveRef(repo, baseRef);
      if (!headSha || !baseSha) return toolErrorText('Validation Failed: head or base ref does not exist');
      const pr = store.createPull(repo, title, body, headRef, headSha, baseRef, baseSha);
      return toolText(JSON.stringify(pullJson(store, repo, pr)));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const number = argNumber(args, 'pull_number');
      if (number === null) return toolErrorText('Missing required argument: pull_number');
      const pr = repo.pulls.get(number);
      if (!pr) return toolErrorText('Not Found');
      if (pr.state === 'closed') return toolErrorText('Pull Request is already closed');
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      if (!baseTip) return toolErrorText('Not Found');
      const headTree = store.commitTree(repo, pr.headSha);
      const tipTree = store.commitTree(repo, baseTip);
      if (!headTree || !tipTree) return toolErrorText('Validation Failed: cannot merge an empty pull request');
      const mergeBase = store.mergeBase(repo, pr.headSha, baseTip);
      const baseTree = mergeBase ? store.commitTree(repo, mergeBase) : undefined;
      let mergedTree: string | null;
      if (baseTree === undefined || mergeBase === baseTip) mergedTree = headTree;
      else mergedTree = store.mergeTrees(repo, baseTree, headTree, tipTree);
      if (mergedTree === null) return toolErrorText('Merge conflict: the pull request cannot be merged cleanly');
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
      return toolText(JSON.stringify({ sha: mergeSha, merged: true, message }));
    }
    case 'get_issue': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const number = argNumber(args, 'issue_number');
      const issue = number === null ? undefined : repo.issues.get(number);
      if (!issue) return toolErrorText('Not Found');
      return toolText(issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      const repo = lookupRepo();
      if (!repo) return toolErrorText('Not Found');
      const state = argString(args, 'state') || 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
      pulls.sort((a, b) => b.number - a.number);
      return toolText(JSON.stringify(pulls.map((p) => pullJson(store, repo, p))));
    }
    default:
      return toolErrorText(`Unknown tool: ${name}`);
  }
}
