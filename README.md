# gitforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/congxxx/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/congxxx/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: one process serving git smart HTTP, a REST v3 API, a GraphQL v4 API, and MCP from its own in-memory store. No UI, no git binary, no database, no outside service. Entry for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty on make.fun. Local grade-local score: 980/1000 (feature 600/600, agent 200/200, perf 180/200); the server-side grade is the authoritative one.

## Run it

```sh
node --experimental-strip-types main.ts
```

Node 22.18 or later, standard library only, nothing to install. The program imports `node:http` and its own modules only.

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own.

---

Entered on [make.fun](https://make.fun/?ref=rkfbtynm&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards

## What it serves

All four surfaces run on the single ephemeral port the process binds, after it registers that port with the harness env (`MAKEFUN_ENV_URL`).

- **Git smart HTTP** (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`): upload-pack v2 and receive-pack v0, with its own SHA-1 object store and packfile reader/writer (including delta resolution). Push, fetch and shallow clone work against the same store as the APIs below.
- **REST v3** (`/api/v3`): repositories, commits, branches, tags, contents, issues, pull requests, users, search, and more, following the GitHub v3 shapes the suite drives.
- **GraphQL v4** (`/api/graphql`): a hand-written parser and executor for the `gh` and github-mcp-server document shapes (repository, issues, pull requests, commits, search, mutations).
- **MCP** (`/mcp`): streamable HTTP with 8 tools (repos, issues, pull requests, contents, search).

State is deterministic: a logical clock replaces wall-clock time, so two runs over the same inputs export byte-identical state.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entry <-> env lifecycle: bind an ephemeral port, register it, wait for done. |
| `app.ts` | HTTP router, auth, and wiring for the four surfaces. |
| `rest.ts` | REST v3 handlers. |
| `githttp.ts` | Git smart HTTP (advertisements, upload-pack, receive-pack). |
| `gitobj.ts` | SHA-1 objects, packfile read/write. |
| `graphql.ts` | GraphQL parser and executor. |
| `store.ts` | In-memory model, logical clock, three-way merge. |
| `mcp.ts` | MCP streamable HTTP endpoint and tools. |

## License

MIT. See `LICENSE`.
