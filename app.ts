// app.ts — the forge's HTTP server: routing, auth, request ids, body reading.
//
// Routes:
//   GET  /healthz                          200 {"ok":true}, no token
//   POST /mcp                              MCP over streamable HTTP (plain JSON)
//   POST /api/graphql                      GitHub GraphQL v4
//   /api/v3/...                            GitHub REST v3
//   /<owner>/<repo>.git/info/refs          git smart-HTTP advertisements
//   /<owner>/<repo>.git/git-upload-pack    git fetch (v2 and v0)
//   /<owner>/<repo>.git/git-receive-pack   git push (v0)
//   anything else                          404 {"message":"Not Found"}
// Auth: every route except /healthz requires `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN` (the env's token, also in process.env); a missing token
// answers 401, a wrong one 401. Every reply carries a non-empty
// X-GitHub-Request-Id and an application/json content type (git replies carry
// their own smart-HTTP content type instead). A malformed JSON body answers 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import * as rest from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './githttp.ts';
import type { RestResult } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** One store per process: the forge's whole state. */
const store = new Store();

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer | null, contentType: string, headers: Record<string, string> = {}): void {
  const allHeaders: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    ...headers,
  };
  if (body === null) {
    res.writeHead(status, allHeaders);
    res.end();
    return;
  }
  allHeaders['content-length'] = String(body.length);
  res.writeHead(status, allHeaders);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function sendRest(res: ServerResponse, result: RestResult): void {
  const body = result.body === null ? null : Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8');
  sendBuffer(res, result.status, body, JSON_TYPE, { 'x-oauth-scopes': 'repo, read:org', ...(result.headers ?? {}) });
}

/**
 * Parse a request URL once: path segments (percent-decoded only when a '%'
 * is present) plus the query string. Never throws. Falls back to the full
 * URL parser only for absolute-form request targets.
 */
function parseRequest(rawUrl: string): { segments: string[]; query: URLSearchParams } {
  const empty = { segments: [] as string[], query: new URLSearchParams() };
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    try {
      const url = new URL(rawUrl);
      return { segments: splitPath(url.pathname), query: url.searchParams };
    } catch {
      return empty;
    }
  }
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? new URLSearchParams() : new URLSearchParams(rawUrl.slice(q + 1));
  return { segments: splitPath(path), query };
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    if (!s.includes('%')) return s;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** Read the whole request body (up to MAX_BODY_BYTES). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request carries the shop token. */
const EXPECTED_AUTH = SHOP_TOKEN === '' ? '' : `Bearer ${SHOP_TOKEN}`;
function authorized(req: IncomingMessage): boolean {
  if (SHOP_TOKEN === '') return true;
  return req.headers.authorization === EXPECTED_AUTH;
}

function unauthorized(res: ServerResponse, missing: boolean): void {
  sendJson(res, 401, { message: missing ? 'Requires authentication' : 'Bad credentials' });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        // A handler must never take the server down (the repo-survives-errors check
        // proves exactly this): answer 500 JSON and keep serving.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do for this request.
          }
        }
      }
    })();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const { segments, query } = parseRequest(req.url ?? '/');
  const host = req.headers.host ?? '127.0.0.1';

  // The env's boot check: 200 {"ok":true}, no token.
  if (method === 'GET' && segments.length === 0) {
    // GET / itself is not a GitHub route; the health probe is /healthz.
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP over streamable HTTP. The handler owns JSON parsing so a body that is
  // not JSON answers HTTP 400 with JSON-RPC -32700.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      unauthorized(res, (req.headers.authorization ?? '') === '');
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'));
    sendBuffer(res, result.status, result.body === null ? null : Buffer.from(result.body, 'utf8'), JSON_TYPE);
    return;
  }

  // GraphQL v4.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      unauthorized(res, (req.headers.authorization ?? '') === '');
      return;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = handleGraphQL(store, parsed.value);
    sendBuffer(res, result.status, Buffer.from(result.body, 'utf8'), JSON_TYPE, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/<service>.
  if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
    const owner = segments[0] ?? '';
    const repoName = (segments[1] ?? '').slice(0, -'.git'.length);
    const service = segments[2] ?? '';
    if (!authorized(req)) {
      unauthorized(res, (req.headers.authorization ?? '') === '');
      return;
    }
    const gitProtocol = req.headers['git-protocol'] ?? null;
    if (method === 'GET' && service === 'info' && segments[3] === 'refs') {
      const requested = query.get('service');
      if (requested !== 'git-upload-pack' && requested !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const result = handleInfoRefs(store, owner, repoName, requested, gitProtocol);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (method === 'POST' && service === 'git-upload-pack') {
      const raw = await readBody(req);
      const result = handleUploadPack(store, owner, repoName, raw, gitProtocol);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    if (method === 'POST' && service === 'git-receive-pack') {
      const raw = await readBody(req);
      const result = handleReceivePack(store, owner, repoName, raw);
      sendBuffer(res, result.status, result.body, result.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GitHub REST v3 under /api/v3.
  if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(req, res, method, segments.slice(2), query, host);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
  host: string,
): Promise<void> {
  if (!authorized(req)) {
    unauthorized(res, (req.headers.authorization ?? '') === '');
    return;
  }
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  let body: unknown = undefined;
  if (needsBody) {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    body = parsed.value;
  }

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendRest(res, rest.handleRoot());
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') {
      sendRest(res, rest.handleMeta());
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GET /api/v3/user, POST /api/v3/user/repos, GET /api/v3/user/repos
  if (segments.length >= 1 && segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      sendRest(res, rest.handleGetUser());
      return;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        sendRest(res, rest.handleCreateRepo(store, body));
        return;
      }
      if (method === 'GET') {
        sendRest(res, rest.handleListUserRepos(store, query, `http://${host}/api/v3/user/repos`));
        return;
      }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] ?? '';
    const repo = segments[2] ?? '';
    const tail = segments.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        sendRest(res, rest.handleGetRepo(store, owner, repo));
        return;
      }
      if (method === 'PATCH') {
        sendRest(res, rest.handlePatchRepo(store, owner, repo, body));
        return;
      }
      if (method === 'DELETE') {
        sendRest(res, rest.handleDeleteRepo(store, owner, repo));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        sendRest(res, rest.handleListBranches(store, owner, repo));
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        sendRest(res, rest.handleGetBranch(store, owner, repo, tail[1] ?? ''));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        sendRest(res, rest.handleCreateRef(store, owner, repo, body));
        return;
      }
      if (tail.length >= 3 && method === 'GET') {
        const ref = `refs/${tail.slice(2).join('/')}`;
        sendRest(res, rest.handleGetRef(store, owner, repo, ref));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        sendRest(res, rest.handleListCommits(store, owner, repo, query));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        sendRest(res, rest.handleGetContent(store, owner, repo, path, query));
        return;
      }
      if (method === 'PUT') {
        sendRest(res, rest.handlePutContent(store, owner, repo, path, body));
        return;
      }
      if (method === 'DELETE') {
        sendRest(res, rest.handleDeleteContent(store, owner, repo, path, body));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        sendRest(res, rest.handleListLabels(store, owner, repo));
        return;
      }
      if (tail.length === 1 && method === 'POST') {
        sendRest(res, rest.handleCreateLabel(store, owner, repo, body));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1 && method === 'POST') {
        sendRest(res, rest.handleCreateIssue(store, owner, repo, body));
        return;
      }
      if (tail.length === 1 && method === 'GET') {
        sendRest(res, rest.handleListIssues(store, owner, repo, query));
        return;
      }
      const number = Number(tail[1] ?? '');
      if (tail.length === 2 && Number.isInteger(number) && number > 0) {
        if (method === 'GET') {
          sendRest(res, rest.handleGetIssue(store, owner, repo, number));
          return;
        }
        if (method === 'PATCH') {
          sendRest(res, rest.handlePatchIssue(store, owner, repo, number, body));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments' && Number.isInteger(number) && number > 0) {
        if (method === 'POST') {
          sendRest(res, rest.handleCreateComment(store, owner, repo, number, body));
          return;
        }
        if (method === 'GET') {
          sendRest(res, rest.handleListComments(store, owner, repo, number));
          return;
        }
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1 && method === 'POST') {
        sendRest(res, rest.handleCreatePull(store, owner, repo, body));
        return;
      }
      if (tail.length === 1 && method === 'GET') {
        sendRest(res, rest.handleListPulls(store, owner, repo, query));
        return;
      }
      const number = Number(tail[1] ?? '');
      if (tail.length === 2 && Number.isInteger(number) && number > 0) {
        if (method === 'GET') {
          sendRest(res, rest.handleGetPull(store, owner, repo, number));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'files' && Number.isInteger(number) && number > 0 && method === 'GET') {
        sendRest(res, rest.handleListPullFiles(store, owner, repo, number));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && Number.isInteger(number) && number > 0 && method === 'PUT') {
        sendRest(res, rest.handleMergePull(store, owner, repo, number, body));
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
