// graphql.ts — GitHub GraphQL v4 (a focused subset) over the same store.
//
// A small recursive-descent parser for the query language plus an executor against
// a hand-written schema. It covers exactly the documents gh and github-mcp-server
// send (per program/env/src/checks-graphql.ts):
//   viewer { login } · repository(owner, name) { id databaseId name nameWithOwner
//   owner defaultBranchRef viewerPermission hasIssuesEnabled issue issues
//   pullRequests pullRequest } · __type introspection (Issue, PullRequest, Repository,
//   SearchType) · issues(first, after, states, orderBy) connections · mutations
//   createIssue / closeIssue / createPullRequest / mergePullRequest / addComment ·
//   node(id:) with inline fragments · batched operation arrays.
// Rules the checks pin down:
//   unknown repository -> data.repository = null, no errors, HTTP 200
//   unknown field -> HTTP 200 with errors, a message naming the field
//   unauthenticated -> 401 (enforced by the router, not here)
//   global ids are opaque (never the bare numeric id) and stable across reads
//   issue state is OPEN/CLOSED; pull request state OPEN/CLOSED/MERGED;
//   mergeable is MERGEABLE/CONFLICTING/UNKNOWN.

import { Store, VIEWER, VIEWER_LOGIN, globalId, parseGlobalId } from './store.ts';
import type { Repo, Issue, PullRequest } from './store.ts';

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'String'; value: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Enum'; value: string }
  | { kind: 'Null' }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> }
  | { kind: 'Variable'; name: string };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  definitions: Array<OperationNode | FragmentNode>;
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos] ?? '')) this.pos += 1;
      if (this.src[this.pos] === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  /** The next token, without consuming it. */
  peek(): string {
    const saved = this.pos;
    try {
      const token = this.next();
      this.pos = saved;
      return token;
    } catch {
      this.pos = saved;
      return this.src[this.pos] ?? '';
    }
  }

  next(): string {
    this.skipIgnored();
    const ch = this.src[this.pos] ?? '';
    if (ch === '') return '';
    // Punctuators.
    if ('!$&():=@[]{|}'.includes(ch)) {
      this.pos += 1;
      return ch;
    }
    if (ch === '.' && this.src.slice(this.pos, this.pos + 3) === '...') {
      this.pos += 3;
      return '...';
    }
    if (ch === '"') {
      // Block string or plain string.
      if (this.src.slice(this.pos, this.pos + 3) === '"""') {
        const end = this.src.indexOf('"""', this.pos + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        const value = this.src.slice(this.pos + 3, end);
        this.pos = end + 3;
        return JSON.stringify(value);
      }
      let out = '';
      this.pos += 1;
      while (this.pos < this.src.length) {
        const c = this.src[this.pos] ?? '';
        if (c === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (c === '\\') {
          const esc = this.src[this.pos + 1] ?? '';
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(this.src.slice(this.pos + 2, this.pos + 6), 16));
            this.pos += 6;
          } else {
            out += map[esc] ?? esc;
            this.pos += 2;
          }
          continue;
        }
        out += c;
        this.pos += 1;
      }
      throw new ParseError('unterminated string');
    }
    if (/[0-9-]/.test(ch)) {
      const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.src.slice(this.pos));
      if (!m) throw new ParseError(`bad number at ${this.pos}`);
      this.pos += m[0].length;
      return m[0];
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
      if (!m) throw new ParseError(`bad name at ${this.pos}`);
      this.pos += m[0].length;
      return m[0];
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at ${this.pos}`);
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${JSON.stringify(token)}, got ${JSON.stringify(got)}`);
  }
}

function parseDocument(src: string): DocumentNode {
  const lexer = new Lexer(src);
  const definitions: DocumentNode['definitions'] = [];
  while (lexer.peek() !== '') {
    const token = lexer.next();
    if (token === 'query' || token === 'mutation') {
      const operation = token as 'query' | 'mutation';
      let name: string | null = null;
      const variables: OperationNode['variables'] = [];
      let next = lexer.peek();
      if (next !== '' && next !== '{' && next !== '(') {
        name = lexer.next();
        next = lexer.peek();
      }
      if (next === '(') {
        lexer.expect('(');
        const skipType = (): void => {
          if (lexer.peek() === '[') {
            lexer.expect('[');
            skipType();
            lexer.expect(']');
          } else {
            lexer.next();
          }
          if (lexer.peek() === '!') lexer.expect('!');
        };
        while (lexer.peek() !== ')') {
          lexer.expect('$');
          const varName = lexer.next();
          lexer.expect(':');
          skipType();
          let defaultValue: ValueNode | undefined;
          if (lexer.peek() === '=') {
            lexer.expect('=');
            defaultValue = parseValue(lexer);
          }
          variables.push({ name: varName, defaultValue });
          if (lexer.peek() === ',') lexer.next();
        }
        lexer.expect(')');
      }
      const selectionSet = parseSelectionSet(lexer);
      definitions.push({ kind: 'Operation', operation, name, variables, selectionSet });
    } else if (token === 'fragment') {
      const name = lexer.next();
      lexer.expect('on');
      const typeCondition = lexer.next();
      const selectionSet = parseSelectionSet(lexer);
      definitions.push({ kind: 'Fragment', name, typeCondition, selectionSet });
    } else if (token === '{') {
      // Shorthand query: rewind by re-parsing from the brace is awkward; treat the
      // already-consumed '{' as the selection set opener.
      const selectionSet = parseSelectionSetBody(lexer);
      definitions.push({ kind: 'Operation', operation: 'query', name: null, variables: [], selectionSet });
    } else {
      throw new ParseError(`unexpected definition token ${JSON.stringify(token)}`);
    }
  }
  return { definitions };
}

function parseSelectionSet(lexer: Lexer): SelectionNode[] {
  lexer.expect('{');
  return parseSelectionSetBody(lexer);
}

function parseSelectionSetBody(lexer: Lexer): SelectionNode[] {
  const selections: SelectionNode[] = [];
  while (lexer.peek() !== '}') {
    if (lexer.peek() === '') throw new ParseError('unterminated selection set');
    if (lexer.peek() === '...') {
      lexer.expect('...');
      const token = lexer.next();
      if (token === 'on') {
        const typeCondition = lexer.next();
        selections.push({ kind: 'InlineFragment', typeCondition, selectionSet: parseSelectionSet(lexer) });
      } else {
        selections.push({ kind: 'FragmentSpread', name: token });
      }
      continue;
    }
    const first = lexer.next();
    let alias: string | null = null;
    let name = first;
    if (lexer.peek() === ':') {
      lexer.expect(':');
      alias = first;
      name = lexer.next();
    }
    const args: FieldNode['args'] = [];
    if (lexer.peek() === '(') {
      lexer.expect('(');
      while (lexer.peek() !== ')') {
        const argName = lexer.next();
        lexer.expect(':');
        args.push({ name: argName, value: parseValue(lexer) });
      }
      lexer.expect(')');
    }
    // Directives (@skip/@include) — parse and ignore.
    while (lexer.peek() === '@') {
      lexer.expect('@');
      lexer.next();
      if (lexer.peek() === '(') {
        lexer.expect('(');
        let depth = 1;
        while (depth > 0) {
          const t = lexer.next();
          if (t === '(' || t === '{' || t === '[') depth += 1;
          else if (t === ')' || t === '}' || t === ']') depth -= 1;
          if (t === '') break;
        }
      }
    }
    const selectionSet = lexer.peek() === '{' ? parseSelectionSet(lexer) : [];
    selections.push({ kind: 'Field', alias, name, args, selectionSet });
  }
  lexer.expect('}');
  return selections;
}

function parseValue(lexer: Lexer): ValueNode {
  const token = lexer.next();
  if (token === '$') return { kind: 'Variable', name: lexer.next() };
  if (token === '[') {
    const values: ValueNode[] = [];
    while (lexer.peek() !== ']') values.push(parseValue(lexer));
    lexer.expect(']');
    return { kind: 'List', values };
  }
  if (token === '{') {
    const fields: Array<{ name: string; value: ValueNode }> = [];
    while (lexer.peek() !== '}') {
      const name = lexer.next();
      lexer.expect(':');
      fields.push({ name, value: parseValue(lexer) });
    }
    lexer.expect('}');
    return { kind: 'Object', fields };
  }
  if (token === 'true') return { kind: 'Boolean', value: true };
  if (token === 'false') return { kind: 'Boolean', value: false };
  if (token === 'null') return { kind: 'Null' };
  if (token.startsWith('"')) {
    try {
      return { kind: 'String', value: JSON.parse(token) as string };
    } catch {
      throw new ParseError(`bad string literal ${token}`);
    }
  }
  if (/^-?[0-9]+$/.test(token)) return { kind: 'Int', value: parseInt(token, 10) };
  if (/^-?[0-9]*\.[0-9]+(?:[eE][+-]?[0-9]+)?$/.test(token) || /^-?[0-9]+[eE][+-]?[0-9]+$/.test(token)) {
    return { kind: 'Float', value: parseFloat(token) };
  }
  return { kind: 'Enum', value: token };
}

// ---------------------------------------------------------------- values

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
interface JsonObject {
  [key: string]: JsonValue;
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'String':
    case 'Int':
    case 'Float':
    case 'Boolean':
      return node.value;
    case 'Null':
      return null;
    case 'Enum':
      return node.value;
    case 'List':
      return node.values.map((v) => valueFromNode(v, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
    case 'Variable':
      return variables[node.name];
  }
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return valueFromNode(arg.value, variables);
}

// ---------------------------------------------------------------- schema data

interface FieldDef {
  name: string;
  description: string;
  args?: Array<{ name: string; type: string }>;
}

const ISSUE_FIELDS: FieldDef[] = [
  { name: 'id', description: 'The global id of the issue.' },
  { name: 'number', description: 'The issue number.' },
  { name: 'title', description: 'The issue title.' },
  { name: 'body', description: 'The issue body.' },
  { name: 'state', description: 'The issue state.' },
  { name: 'createdAt', description: 'When the issue was created.' },
  { name: 'updatedAt', description: 'When the issue was last updated.' },
  { name: 'author', description: 'The issue author.' },
  { name: 'labels', description: 'The labels on the issue.' },
  { name: 'comments', description: 'The comments on the issue.' },
  { name: 'url', description: 'The issue URL.' },
];

const PULL_REQUEST_FIELDS: FieldDef[] = [
  { name: 'id', description: 'The global id of the pull request.' },
  { name: 'number', description: 'The pull request number.' },
  { name: 'title', description: 'The pull request title.' },
  { name: 'body', description: 'The pull request body.' },
  { name: 'state', description: 'The pull request state.' },
  { name: 'merged', description: 'Whether the pull request was merged.' },
  { name: 'mergeable', description: 'Whether the pull request can be merged.' },
  { name: 'headRefName', description: 'The head branch name.' },
  { name: 'baseRefName', description: 'The base branch name.' },
  { name: 'headRef', description: 'The head ref.' },
  { name: 'baseRef', description: 'The base ref.' },
  { name: 'files', description: 'The files changed by the pull request.' },
  { name: 'createdAt', description: 'When the pull request was created.' },
  { name: 'updatedAt', description: 'When the pull request was last updated.' },
  { name: 'author', description: 'The pull request author.' },
  { name: 'url', description: 'The pull request URL.' },
];

const REPOSITORY_FIELDS: FieldDef[] = [
  { name: 'id', description: 'The global id of the repository.' },
  { name: 'databaseId', description: 'The numeric id of the repository.' },
  { name: 'name', description: 'The repository name.' },
  { name: 'nameWithOwner', description: 'The repository name with its owner.' },
  { name: 'owner', description: 'The repository owner.' },
  { name: 'description', description: 'The repository description.' },
  { name: 'defaultBranchRef', description: 'The default branch ref.' },
  { name: 'viewerPermission', description: "The viewer's permission on the repository." },
  { name: 'hasIssuesEnabled', description: 'Whether issues are enabled.' },
  { name: 'isPrivate', description: 'Whether the repository is private.' },
  { name: 'issue', description: 'One issue by number.' },
  { name: 'issues', description: 'The issues of the repository.' },
  { name: 'pullRequests', description: 'The pull requests of the repository.' },
  { name: 'pullRequest', description: 'One pull request by number.' },
  { name: 'url', description: 'The repository URL.' },
];

const TYPE_FIELDS: Record<string, FieldDef[]> = {
  Issue: ISSUE_FIELDS,
  PullRequest: PULL_REQUEST_FIELDS,
  Repository: REPOSITORY_FIELDS,
  User: [
    { name: 'id', description: 'The global id of the user.' },
    { name: 'login', description: 'The user login.' },
    { name: 'name', description: 'The user name.' },
    { name: 'email', description: 'The user email.' },
  ],
  Viewer: [
    { name: 'id', description: 'The global id of the viewer.' },
    { name: 'login', description: 'The viewer login.' },
    { name: 'name', description: 'The viewer name.' },
    { name: 'email', description: 'The viewer email.' },
  ],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- execution

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Resolver = (parent: unknown, field: FieldNode, ctx: ExecContext) => unknown;

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function executeSelectionSet(
  selections: SelectionNode[],
  parent: unknown,
  parentType: string,
  ctx: ExecContext,
): JsonObject {
  const out: JsonObject = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      const nested = executeSelectionSet(fragment.selectionSet, parent, fragment.typeCondition, ctx);
      Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      const nested = executeSelectionSet(selection.selectionSet, parent, selection.typeCondition ?? parentType, ctx);
      Object.assign(out, nested);
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    const resolver = resolversFor(parentType)[field.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(parent, field, ctx);
    } catch (e) {
      ctx.errors.push({ message: (e as Error).message });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, field, ctx);
  }
  return out;
}

/** Resolve a field value against its sub-selections (or return it as a leaf). */
function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): JsonValue {
  if (value === null || value === undefined) return null;
  if (field.selectionSet.length === 0) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, field, ctx));
  }
  if (isObject(value) && typeof value.__typename === 'string') {
    return executeSelectionSet(field.selectionSet, value, value.__typename as string, ctx);
  }
  return null;
}

function resolversFor(typeName: string): Record<string, Resolver> {
  switch (typeName) {
    case 'Query':
      return QUERY_RESOLVERS;
    case 'Mutation':
      return MUTATION_RESOLVERS;
    case 'Repository':
      return REPOSITORY_RESOLVERS;
    case 'Issue':
      return ISSUE_RESOLVERS;
    case 'PullRequest':
      return PULL_REQUEST_RESOLVERS;
    case 'User':
    case 'Viewer':
    case 'Actor':
      return USER_RESOLVERS;
    case 'Ref':
      return REF_RESOLVERS;
    case 'IssueConnection':
      return ISSUE_CONNECTION_RESOLVERS;
    case 'PullRequestConnection':
      return PULL_REQUEST_CONNECTION_RESOLVERS;
    case 'IssueEdge':
    case 'PullRequestEdge':
      return EDGE_RESOLVERS;
    case 'PageInfo':
      return PAGE_INFO_RESOLVERS;
    case 'LabelConnection':
      return LABEL_CONNECTION_RESOLVERS;
    case 'Label':
      return LABEL_RESOLVERS;
    case 'IssueCommentConnection':
      return COMMENT_CONNECTION_RESOLVERS;
    case 'IssueComment':
      return COMMENT_RESOLVERS;
    case 'PullRequestChangedFileConnection':
      return FILE_CONNECTION_RESOLVERS;
    case 'PullRequestChangedFile':
      return FILE_RESOLVERS;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return MUTATION_PAYLOAD_RESOLVERS;
    case 'AddCommentPayload':
      return ADD_COMMENT_PAYLOAD_RESOLVERS;
    case 'AddedCommentEdge':
      return ADDED_COMMENT_EDGE_RESOLVERS;
    case '__Type':
      return INTROSPECTION_TYPE_RESOLVERS;
    case '__Field':
      return INTROSPECTION_FIELD_RESOLVERS;
    case '__EnumValue':
      return INTROSPECTION_ENUM_VALUE_RESOLVERS;
    case '__Schema':
      return INTROSPECTION_SCHEMA_RESOLVERS;
    default:
      return {};
  }
}

// ---------------------------------------------------------------- object wrappers

function repoObject(repo: Repo): Record<string, unknown> {
  return { __typename: 'Repository', __repo: repo };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}

function pullObject(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return { __typename: 'PullRequest', __repo: repo, __pr: pr };
}

function userObject(login: string): Record<string, unknown> {
  return { __typename: 'User', __login: login };
}

function getRepo(obj: Record<string, unknown>): Repo {
  return obj.__repo as Repo;
}

function getIssue(obj: Record<string, unknown>): Issue {
  return obj.__issue as Issue;
}

function getPull(obj: Record<string, unknown>): PullRequest {
  return obj.__pr as PullRequest;
}

// ---------------------------------------------------------------- connections

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1] ?? '0', 10) : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  number: number;
  node: Record<string, unknown>;
}

function buildConnection(
  typeName: string,
  items: ConnectionItem[],
  field: FieldNode,
  ctx: ExecContext,
): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const firstN = typeof first === 'number' ? first : 100;
  let start = 0;
  if (typeof after === 'string') {
    const afterNumber = numberFromCursor(after);
    if (afterNumber !== null) {
      const index = items.findIndex((item) => item.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const slice = items.slice(start, start + firstN);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length > 0 ? cursorFor(slice[slice.length - 1]?.number ?? 0) : null;
  const startCursor = slice.length > 0 ? cursorFor(slice[0]?.number ?? 0) : null;
  return {
    __typename: typeName,
    __nodes: slice.map((item) => item.node),
    __edges: slice.map((item) => ({
      __typename: typeName.replace('Connection', 'Edge'),
      __node: item.node,
      __cursor: cursorFor(item.number),
    })),
    __pageInfo: {
      __typename: 'PageInfo',
      __hasNextPage: hasNextPage,
      __hasPreviousPage: start > 0,
      __startCursor: startCursor,
      __endCursor: endCursor,
    },
    __totalCount: items.length,
  };
}

// ---------------------------------------------------------------- resolvers

const QUERY_RESOLVERS: Record<string, Resolver> = {
  viewer: () => ({ __typename: 'Viewer', __login: VIEWER_LOGIN }),
  repository: (_parent, field, ctx) => {
    const owner = argValue(field, 'owner', ctx.variables);
    const name = argValue(field, 'name', ctx.variables);
    if (typeof owner !== 'string' || typeof name !== 'string') return null;
    if (owner.toLowerCase() !== VIEWER_LOGIN) return null;
    const repo = ctx.store.getRepo(owner, name);
    return repo ? repoObject(repo) : null;
  },
  node: (_parent, field, ctx) => {
    const id = argValue(field, 'id', ctx.variables);
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    if (parsed.kind === 'repo') {
      const repo = ctx.store.reposById.get(Number(parsed.parts[0] ?? ''));
      return repo ? repoObject(repo) : null;
    }
    if (parsed.kind === 'issue') {
      const repo = ctx.store.reposById.get(Number(parsed.parts[0] ?? ''));
      const issue = repo?.issues.get(Number(parsed.parts[1] ?? ''));
      return repo && issue ? issueObject(repo, issue) : null;
    }
    if (parsed.kind === 'pull') {
      const repo = ctx.store.reposById.get(Number(parsed.parts[0] ?? ''));
      const pr = repo?.pulls.get(Number(parsed.parts[1] ?? ''));
      return repo && pr ? pullObject(repo, pr) : null;
    }
    return null;
  },
  __type: (_parent, field, ctx) => {
    const name = argValue(field, 'name', ctx.variables);
    if (typeof name !== 'string') return null;
    return { __typename: '__Type', __typeName: name };
  },
  __schema: () => ({ __typename: '__Schema' }),
};

const USER_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => globalId('user', (parent as Record<string, unknown>).__login === VIEWER_LOGIN ? 1000 : 0),
  login: (parent) => (parent as Record<string, unknown>).__login as string,
  name: (parent) => {
    const login = (parent as Record<string, unknown>).__login as string;
    return login === VIEWER_LOGIN ? VIEWER.name : login;
  },
  email: (parent) => {
    const login = (parent as Record<string, unknown>).__login as string;
    return login === VIEWER_LOGIN ? VIEWER.email : `${login}@example.invalid`;
  },
};

const REF_RESOLVERS: Record<string, Resolver> = {
  name: (parent) => (parent as Record<string, unknown>).__name as string,
  id: (parent) => globalId('ref', (parent as Record<string, unknown>).__name as string),
  target: (parent) => parent,
};

const REPOSITORY_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => globalId('repo', getRepo(parent as Record<string, unknown>).id),
  databaseId: (parent) => getRepo(parent as Record<string, unknown>).id,
  name: (parent) => getRepo(parent as Record<string, unknown>).name,
  nameWithOwner: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    return `${repo.owner.login}/${repo.name}`;
  },
  owner: (parent) => userObject(getRepo(parent as Record<string, unknown>).owner.login),
  description: (parent) => getRepo(parent as Record<string, unknown>).description,
  isPrivate: (parent) => getRepo(parent as Record<string, unknown>).private,
  url: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    return `https://github.com/${repo.owner.login}/${repo.name}`;
  },
  defaultBranchRef: (parent, _field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const tip = ctx.store.defaultTip(repo);
    if (!tip) return null;
    return { __typename: 'Ref', __name: repo.default_branch, __oid: tip };
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: (parent) => getRepo(parent as Record<string, unknown>).has_issues,
  issue: (parent, field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const number = argValue(field, 'number', ctx.variables);
    if (typeof number !== 'number') return null;
    const issue = repo.issues.get(number);
    return issue ? issueObject(repo, issue) : null;
  },
  issues: (parent, field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const states = argValue(field, 'states', ctx.variables);
    const orderBy = argValue(field, 'orderBy', ctx.variables);
    let list = [...repo.issues.values()];
    const wanted: string[] = Array.isArray(states) ? (states as string[]) : ['OPEN'];
    list = list.filter((issue) => wanted.includes(issue.state.toUpperCase()));
    let direction = 'DESC';
    if (isObject(orderBy) && typeof orderBy.direction === 'string') direction = orderBy.direction;
    list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    return buildConnection(
      'IssueConnection',
      list.map((issue) => ({ number: issue.number, node: issueObject(repo, issue) })),
      field,
      ctx,
    );
  },
  pullRequest: (parent, field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const number = argValue(field, 'number', ctx.variables);
    if (typeof number !== 'number') return null;
    const pr = repo.pulls.get(number);
    return pr ? pullObject(repo, pr) : null;
  },
  pullRequests: (parent, field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const states = argValue(field, 'states', ctx.variables);
    let list = [...repo.pulls.values()];
    if (Array.isArray(states)) {
      const wanted = (states as string[]).map((s) => s.toUpperCase());
      list = list.filter((pr) => {
        const state = pr.merged ? 'MERGED' : pr.state.toUpperCase();
        return wanted.includes(state);
      });
    } else {
      list = list.filter((pr) => pr.state === 'open');
    }
    list.sort((a, b) => b.number - a.number);
    return buildConnection(
      'PullRequestConnection',
      list.map((pr) => ({ number: pr.number, node: pullObject(repo, pr) })),
      field,
      ctx,
    );
  },
};

const ISSUE_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    return globalId('issue', repo.id, getIssue(parent as Record<string, unknown>).number);
  },
  number: (parent) => getIssue(parent as Record<string, unknown>).number,
  title: (parent) => getIssue(parent as Record<string, unknown>).title,
  body: (parent) => getIssue(parent as Record<string, unknown>).body ?? '',
  state: (parent) => getIssue(parent as Record<string, unknown>).state.toUpperCase(),
  createdAt: (parent) => getIssue(parent as Record<string, unknown>).created_at,
  updatedAt: (parent) => getIssue(parent as Record<string, unknown>).updated_at,
  author: (parent) => userObject(getIssue(parent as Record<string, unknown>).user.login),
  url: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const issue = getIssue(parent as Record<string, unknown>);
    return `https://github.com/${repo.owner.login}/${repo.name}/issues/${issue.number}`;
  },
  labels: (parent, field, ctx) => {
    const issue = getIssue(parent as Record<string, unknown>);
    return buildConnection(
      'LabelConnection',
      issue.labels.map((label, index) => ({
        number: index + 1,
        node: { __typename: 'Label', __label: label },
      })),
      field,
      ctx,
    );
  },
  comments: (parent, field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const issue = getIssue(parent as Record<string, unknown>);
    return buildConnection(
      'IssueCommentConnection',
      issue.comments.map((comment) => ({
        number: comment.id,
        node: { __typename: 'IssueComment', __repo: repo, __issue: issue, __comment: comment },
      })),
      field,
      ctx,
    );
  },
};

const LABEL_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (parent) => (parent as Record<string, unknown>).__nodes as unknown[],
  edges: (parent) => (parent as Record<string, unknown>).__edges as unknown[],
  pageInfo: (parent) => (parent as Record<string, unknown>).__pageInfo as Record<string, unknown>,
  totalCount: (parent) => (parent as Record<string, unknown>).__totalCount as number,
};

const LABEL_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => globalId('label', ((parent as Record<string, unknown>).__label as { id: number }).id),
  name: (parent) => ((parent as Record<string, unknown>).__label as { name: string }).name,
  color: (parent) => ((parent as Record<string, unknown>).__label as { color: string }).color,
  description: (parent) => ((parent as Record<string, unknown>).__label as { description: string }).description ?? '',
};

const COMMENT_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (parent) => (parent as Record<string, unknown>).__nodes as unknown[],
  edges: (parent) => (parent as Record<string, unknown>).__edges as unknown[],
  pageInfo: (parent) => (parent as Record<string, unknown>).__pageInfo as Record<string, unknown>,
  totalCount: (parent) => (parent as Record<string, unknown>).__totalCount as number,
};

const COMMENT_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => {
    const obj = parent as Record<string, unknown>;
    const comment = obj.__comment as { id: number };
    const repo = obj.__repo as Repo;
    const issue = obj.__issue as Issue;
    return globalId('comment', repo.id, issue.number, comment.id);
  },
  body: (parent) => ((parent as Record<string, unknown>).__comment as { body: string }).body,
  author: (parent) => userObject(((parent as Record<string, unknown>).__comment as { user: { login: string } }).user.login),
  createdAt: (parent) => ((parent as Record<string, unknown>).__comment as { created_at: string }).created_at,
  updatedAt: (parent) => ((parent as Record<string, unknown>).__comment as { updated_at: string }).updated_at,
};

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeable(store: Store, repo: Repo, pr: PullRequest): string {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return 'UNKNOWN';
  const headTree = store.commitTree(repo, pr.headSha);
  const tipTree = store.commitTree(repo, baseTip);
  if (!headTree || !tipTree) return 'UNKNOWN';
  const base = store.mergeBase(repo, pr.headSha, baseTip);
  if (!base) return 'UNKNOWN';
  if (base === baseTip) return 'MERGEABLE';
  const baseTree = store.commitTree(repo, base);
  if (!baseTree) return 'UNKNOWN';
  return store.hasMergeConflict(repo, baseTree, headTree, tipTree) ? 'CONFLICTING' : 'MERGEABLE';
}

const PULL_REQUEST_RESOLVERS: Record<string, Resolver> = {
  id: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    return globalId('pull', repo.id, getPull(parent as Record<string, unknown>).number);
  },
  number: (parent) => getPull(parent as Record<string, unknown>).number,
  title: (parent) => getPull(parent as Record<string, unknown>).title,
  body: (parent) => getPull(parent as Record<string, unknown>).body ?? '',
  state: (parent) => prState(getPull(parent as Record<string, unknown>)),
  merged: (parent) => getPull(parent as Record<string, unknown>).merged,
  mergeable: (parent, _field, ctx) => {
    const repo = getRepo(parent as Record<string, unknown>);
    return prMergeable(ctx.store, repo, getPull(parent as Record<string, unknown>));
  },
  headRefName: (parent) => getPull(parent as Record<string, unknown>).headRef,
  baseRefName: (parent) => getPull(parent as Record<string, unknown>).baseRef,
  headRef: (parent) => {
    const pr = getPull(parent as Record<string, unknown>);
    return { __typename: 'Ref', __name: pr.headRef, __oid: pr.headSha };
  },
  baseRef: (parent) => {
    const pr = getPull(parent as Record<string, unknown>);
    return { __typename: 'Ref', __name: pr.baseRef, __oid: pr.baseSha };
  },
  createdAt: (parent) => getPull(parent as Record<string, unknown>).created_at,
  updatedAt: (parent) => getPull(parent as Record<string, unknown>).updated_at,
  author: (parent) => userObject(getPull(parent as Record<string, unknown>).user.login),
  url: (parent) => {
    const repo = getRepo(parent as Record<string, unknown>);
    const pr = getPull(parent as Record<string, unknown>);
    return `https://github.com/${repo.owner.login}/${repo.name}/pull/${pr.number}`;
  },
  files: (parent, field, ctx) => {
    const store = ctx.store;
    const repo = getRepo(parent as Record<string, unknown>);
    const pr = getPull(parent as Record<string, unknown>);
    let files = pr.filesCache;
    if (files === null) {
      const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
      const mergeBase = baseTip ? store.mergeBase(repo, pr.headSha, baseTip) : undefined;
      const baseTree = mergeBase ? store.commitTree(repo, mergeBase) : baseTip ? store.commitTree(repo, baseTip) : undefined;
      const headTree = store.commitTree(repo, pr.headSha);
      files = headTree ? store.diffTrees(repo, baseTree, headTree) : [];
      pr.filesCache = files;
    }
    return buildConnection(
      'PullRequestChangedFileConnection',
      files.map((file, index) => ({
        number: index + 1,
        node: { __typename: 'PullRequestChangedFile', __file: file },
      })),
      field,
      ctx,
    );
  },
};

const FILE_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (parent) => (parent as Record<string, unknown>).__nodes as unknown[],
  edges: (parent) => (parent as Record<string, unknown>).__edges as unknown[],
  pageInfo: (parent) => (parent as Record<string, unknown>).__pageInfo as Record<string, unknown>,
  totalCount: (parent) => (parent as Record<string, unknown>).__totalCount as number,
};

const FILE_RESOLVERS: Record<string, Resolver> = {
  path: (parent) => ((parent as Record<string, unknown>).__file as { filename: string }).filename,
  additions: (parent) => ((parent as Record<string, unknown>).__file as { additions: number }).additions,
  deletions: (parent) => ((parent as Record<string, unknown>).__file as { deletions: number }).deletions,
  changeType: (parent) => ((parent as Record<string, unknown>).__file as { status: string }).status.toUpperCase(),
};

const ISSUE_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (parent) => (parent as Record<string, unknown>).__nodes as unknown[],
  edges: (parent) => (parent as Record<string, unknown>).__edges as unknown[],
  pageInfo: (parent) => (parent as Record<string, unknown>).__pageInfo as Record<string, unknown>,
  totalCount: (parent) => (parent as Record<string, unknown>).__totalCount as number,
};

const PULL_REQUEST_CONNECTION_RESOLVERS: Record<string, Resolver> = {
  nodes: (parent) => (parent as Record<string, unknown>).__nodes as unknown[],
  edges: (parent) => (parent as Record<string, unknown>).__edges as unknown[],
  pageInfo: (parent) => (parent as Record<string, unknown>).__pageInfo as Record<string, unknown>,
  totalCount: (parent) => (parent as Record<string, unknown>).__totalCount as number,
};

const EDGE_RESOLVERS: Record<string, Resolver> = {
  node: (parent) => (parent as Record<string, unknown>).__node as Record<string, unknown>,
  cursor: (parent) => (parent as Record<string, unknown>).__cursor as string,
};

const PAGE_INFO_RESOLVERS: Record<string, Resolver> = {
  hasNextPage: (parent) => (parent as Record<string, unknown>).__hasNextPage as boolean,
  hasPreviousPage: (parent) => (parent as Record<string, unknown>).__hasPreviousPage as boolean,
  startCursor: (parent) => (parent as Record<string, unknown>).__startCursor as string | null,
  endCursor: (parent) => (parent as Record<string, unknown>).__endCursor as string | null,
};

// ---------------------------------------------------------------- mutations

function inputObject(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const input = argValue(field, 'input', ctx.variables);
  return isObject(input) ? input : {};
}

function findRepoByGlobalId(ctx: ExecContext, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  return ctx.store.reposById.get(Number(parsed.parts[0] ?? '')) ?? null;
}

function findIssueByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const repo = ctx.store.reposById.get(Number(parsed.parts[0] ?? ''));
  const issue = repo?.issues.get(Number(parsed.parts[1] ?? ''));
  return repo && issue ? { repo, issue } : null;
}

function findPullByGlobalId(ctx: ExecContext, id: unknown): { repo: Repo; pr: PullRequest } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'pull') return null;
  const repo = ctx.store.reposById.get(Number(parsed.parts[0] ?? ''));
  const pr = repo?.pulls.get(Number(parsed.parts[1] ?? ''));
  return repo && pr ? { repo, pr } : null;
}

const MUTATION_RESOLVERS: Record<string, Resolver> = {
  createIssue: (_parent, field, ctx) => {
    const input = inputObject(field, ctx);
    const repo = findRepoByGlobalId(ctx, input.repositoryId);
    if (!repo) throw new Error('Could not resolve to a Repository with the global id.');
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const issue = ctx.store.createIssue(repo, title, body, []);
    return { __typename: 'CreateIssuePayload', __issue: issueObject(repo, issue), __repo: repo };
  },
  closeIssue: (_parent, field, ctx) => {
    const input = inputObject(field, ctx);
    const found = findIssueByGlobalId(ctx, input.issueId);
    if (!found) throw new Error('Could not resolve to an Issue with the global id.');
    found.issue.state = 'closed';
    found.issue.updated_at = ctx.store.tick();
    found.issue.jsonCache = null; found.issue.jsonBuf = null;
    return { __typename: 'CloseIssuePayload', __issue: issueObject(found.repo, found.issue), __repo: found.repo };
  },
  createPullRequest: (_parent, field, ctx) => {
    const input = inputObject(field, ctx);
    const repo = findRepoByGlobalId(ctx, input.repositoryId);
    if (!repo) throw new Error('Could not resolve to a Repository with the global id.');
    const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : repo.default_branch;
    const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
    const headSha = ctx.store.resolveRef(repo, headRef);
    const baseSha = ctx.store.resolveRef(repo, baseRef);
    if (!headSha || !baseSha) throw new Error('Head or base ref does not exist.');
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const pr = ctx.store.createPull(repo, title, body, headRef, headSha, baseRef, baseSha);
    return { __typename: 'CreatePullRequestPayload', __pr: pullObject(repo, pr), __repo: repo };
  },
  mergePullRequest: (_parent, field, ctx) => {
    const input = inputObject(field, ctx);
    const found = findPullByGlobalId(ctx, input.pullRequestId);
    if (!found) throw new Error('Could not resolve to a PullRequest with the global id.');
    const { repo, pr } = found;
    if (pr.state !== 'open') throw new Error('Pull request is already closed.');
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (!baseTip) throw new Error('Base branch does not exist.');
    const headTree = ctx.store.commitTree(repo, pr.headSha);
    const tipTree = ctx.store.commitTree(repo, baseTip);
    if (!headTree || !tipTree) throw new Error('Cannot merge an empty pull request.');
    const mergeBase = ctx.store.mergeBase(repo, pr.headSha, baseTip);
    const baseTree = mergeBase ? ctx.store.commitTree(repo, mergeBase) : undefined;
    let mergedTree: string | null;
    if (baseTree === undefined || mergeBase === baseTip) mergedTree = headTree;
    else mergedTree = ctx.store.mergeTrees(repo, baseTree, headTree, tipTree);
    if (mergedTree === null) throw new Error('Merge conflict: the pull request cannot be merged cleanly.');
    const message = `${pr.title} (#${pr.number})`;
    const mergeSha = ctx.store.makeCommit(repo, mergedTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    ctx.store.bumpRefs(repo);
    pr.state = 'closed';
    pr.merged = true;
    pr.merged_at = ctx.store.tick();
    pr.updated_at = pr.merged_at;
    pr.merge_commit_sha = mergeSha;
    pr.filesCache = null;
    return { __typename: 'MergePullRequestPayload', __pr: pullObject(repo, pr), __repo: repo };
  },
  addComment: (_parent, field, ctx) => {
    const input = inputObject(field, ctx);
    const body = typeof input.body === 'string' ? input.body : '';
    const issueFound = findIssueByGlobalId(ctx, input.subjectId);
    if (issueFound) {
      const comment = ctx.store.createComment(issueFound.repo, issueFound.issue, body);
      const node = { __typename: 'IssueComment', __repo: issueFound.repo, __issue: issueFound.issue, __comment: comment };
      return {
        __typename: 'AddCommentPayload',
        __commentEdge: { __typename: 'AddedCommentEdge', __node: node },
        __subject: issueObject(issueFound.repo, issueFound.issue),
      };
    }
    const pullFound = findPullByGlobalId(ctx, input.subjectId);
    if (pullFound) {
      // Comments on pull requests are stored as issue comments on the matching
      // number in the same repository (GitHub shares the numbering).
      let issue = pullFound.repo.issues.get(pullFound.pr.number);
      if (!issue) issue = ctx.store.createIssue(pullFound.repo, pullFound.pr.title, pullFound.pr.body, []);
      const comment = ctx.store.createComment(pullFound.repo, issue, body);
      const node = { __typename: 'IssueComment', __repo: pullFound.repo, __issue: issue, __comment: comment };
      return {
        __typename: 'AddCommentPayload',
        __commentEdge: { __typename: 'AddedCommentEdge', __node: node },
        __subject: pullObject(pullFound.repo, pullFound.pr),
      };
    }
    throw new Error('Could not resolve to a subject with the global id.');
  },
};

const MUTATION_PAYLOAD_RESOLVERS: Record<string, Resolver> = {
  issue: (parent) => (parent as Record<string, unknown>).__issue as Record<string, unknown>,
  pullRequest: (parent) => (parent as Record<string, unknown>).__pr as Record<string, unknown>,
  clientMutationId: () => null,
};

const ADD_COMMENT_PAYLOAD_RESOLVERS: Record<string, Resolver> = {
  commentEdge: (parent) => (parent as Record<string, unknown>).__commentEdge as Record<string, unknown>,
  subject: (parent) => (parent as Record<string, unknown>).__subject as Record<string, unknown>,
  clientMutationId: () => null,
};

const ADDED_COMMENT_EDGE_RESOLVERS: Record<string, Resolver> = {
  node: (parent) => (parent as Record<string, unknown>).__node as Record<string, unknown>,
  cursor: () => null,
};

// ---------------------------------------------------------------- introspection

const INTROSPECTION_TYPE_RESOLVERS: Record<string, Resolver> = {
  kind: (parent) => {
    const name = (parent as Record<string, unknown>).__typeName as string;
    if (ENUM_VALUES[name]) return 'ENUM';
    return 'OBJECT';
  },
  name: (parent) => (parent as Record<string, unknown>).__typeName as string,
  description: () => null,
  fields: (parent, field, ctx) => {
    const name = (parent as Record<string, unknown>).__typeName as string;
    const defs = TYPE_FIELDS[name] ?? [];
    const includeDeprecated = argValue(field, 'includeDeprecated', ctx.variables);
    void includeDeprecated;
    void ctx;
    return defs.map((def) => ({ __typename: '__Field', __field: def }));
  },
  enumValues: (parent) => {
    const name = (parent as Record<string, unknown>).__typeName as string;
    return (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', __name: value }));
  },
  interfaces: () => [],
  possibleTypes: () => [],
};

const INTROSPECTION_FIELD_RESOLVERS: Record<string, Resolver> = {
  name: (parent) => ((parent as Record<string, unknown>).__field as FieldDef).name,
  description: (parent) => ((parent as Record<string, unknown>).__field as FieldDef).description,
  args: () => [],
  type: () => ({ __typename: '__Type', __typeName: 'String' }),
  isDeprecated: () => false,
  deprecationReason: () => null,
};

const INTROSPECTION_ENUM_VALUE_RESOLVERS: Record<string, Resolver> = {
  name: (parent) => (parent as Record<string, unknown>).__name as string,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
};

const INTROSPECTION_SCHEMA_RESOLVERS: Record<string, Resolver> = {
  queryType: () => ({ __typename: '__Type', __typeName: 'Query' }),
  mutationType: () => ({ __typename: '__Type', __typeName: 'Mutation' }),
  subscriptionType: () => null,
  types: () => Object.keys(TYPE_FIELDS).map((name) => ({ __typename: '__Type', __typeName: name })),
  directives: () => [],
};

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  status: number;
  body: string;
}

/** Execute one GraphQL request body (object or array for batching). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((item) => executeOne(store, item));
    return { status: 200, body: JSON.stringify(results) };
  }
  return { status: 200, body: JSON.stringify(executeOne(store, body)) };
}

function executeOne(store: Store, request: unknown): JsonObject {
  if (!isObject(request) || typeof request.query !== 'string') {
    return { errors: [{ message: 'GraphQL request must carry a query string.' }] };
  }
  const variables: Record<string, unknown> = isObject(request.variables) ? (request.variables as Record<string, unknown>) : {};
  let document: DocumentNode;
  try {
    document = parseDocument(request.query);
  } catch (e) {
    return { errors: [{ message: `GraphQL syntax error: ${(e as Error).message}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  for (const definition of document.definitions) {
    if (definition.kind === 'Fragment') fragments.set(definition.name, definition);
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operations = document.definitions.filter((d): d is OperationNode => d.kind === 'Operation');
  let operation: OperationNode | undefined;
  if (operationName !== null) operation = operations.find((op) => op.name === operationName);
  else operation = operations[0];
  if (!operation) return { errors: [{ message: 'No operation found in the GraphQL document.' }] };
  const ctx: ExecContext = { store, variables, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(operation.selectionSet, {}, rootType, ctx);
  const out: JsonObject = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors as unknown as JsonValue;
  return out;
}
