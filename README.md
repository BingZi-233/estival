<div align="center">

# 🌻 Estival

**Turn [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) skills into schema-enforced REST endpoints.**

Drop a `SKILL.md`, get an API.

English | [简体中文](./README.zh-CN.md)

</div>

---

Estival is a small, production-minded web framework for shipping LLM agents as plain HTTP
APIs. You write a skill as a Markdown file with YAML frontmatter — params in, JSON schema
out — and Estival discovers it at startup and exposes it as its own endpoint. Each request
runs the agent in a **read-only sandbox** and validates the result against the skill's
declared output schema before returning it. No glue code, no per-endpoint boilerplate.

> *Estival* (adj.) — *of, or occurring in, high summer.* The framework formerly extracted
> from an internal "scene-agent" service.

## Why

- **Skills are the API.** One `SKILL.md` = one endpoint. The frontmatter *is* the HTTP
  contract (params + output JSON schema), enforced on every response.
- **Safe by default.** Skills run with only `Read` / `Glob` / `Grep`. Writing files or
  running commands is opt-in, per skill, via an MCP sidecar.
- **Four call shapes, zero extra code.** Every skill gets sync, streaming (SSE), and
  (with a database) async submit/poll endpoints for free.
- **Built for ops.** Concurrency limit + queue, per-run wall-clock timeout, body-size
  caps, structured logging, graceful shutdown, file upload + cleanup.
- **Secrets never touch the model.** Request headers are forwarded to MCP servers as
  `HTTP_*` env on an opt-in basis — bearer tokens flow to tools, not into prompts.

## Requirements

- Node.js 18+ (Node 22+ for the Docker image / pnpm@11)
- A Claude Agent SDK auth setup (a `CLAUDE_CONFIG_DIR` with valid credentials)
- PostgreSQL — **only** for the async `submit`/`detail` endpoints; sync and stream need no DB

## Quick start

```bash
npx estival init      # scaffold ./.claude/skills/hello + .env
# edit .env → set CLAUDE_CONFIG_DIR to a dir with Agent SDK credentials
npx estival           # boot the server on :3000
```

Then call the example skill:

```bash
curl -s localhost:3000/skills | jq                 # list discovered skills
curl -s -X POST localhost:3000/skills/hello \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","message":"shipping an agent today"}' | jq
# → { "success": true, "data": { "greeting": "Hello, Ada!", "summary": "..." }, ... }
```

Or use it as a dependency in an existing project:

```bash
pnpm add estival
# put your skills in ./.claude/skills, then:
pnpm estival
```

## Writing a skill

A skill is a directory under `.claude/skills/<name>/` containing a `SKILL.md`:

```markdown
---
name: hello
description: Greet a caller and echo a short structured summary.
params:
  required:
    - name: name
      type: string
      description: Who to greet.
  optional:
    - name: message
      type: string
      description: An optional message to summarize.
output:                       # any JSON Schema; enforced on the response
  type: object
  properties:
    greeting: { type: string }
    summary:  { type: string }
  required: [greeting, summary]
---

# Hello

Instructions to the agent go here, in plain Markdown.
Return JSON matching the `output` schema above.
```

- `name` must match `^[a-z0-9][a-z0-9-]*$` (it becomes the route path).
- `params.required` / `params.optional` validate the request body.
- `output` is any JSON Schema; the agent is forced to produce a matching object.
- Add `enabled: false` to the frontmatter to temporarily disable a skill.
- A param with `resolve: file` is treated as a file reference: uploaded multipart files
  or remote references are downloaded to a local path before the run.

## Endpoints

Every loaded skill `<name>` exposes:

| Method & path | Mode | Notes |
|---|---|---|
| `POST /skills/<name>` | sync | Run and return the validated JSON. |
| `POST /skills/<name>/stream` | SSE | Stream raw SDK messages as `data:` frames. |
| `POST /skills/<name>/submit` | async | Returns `202 { taskId }`. Requires `DATABASE_URL`. |
| `GET  /skills/<name>/task/detail?taskId=…` | async | Poll task status/result. |

Plus, globally: `GET /health`, `GET /skills` (catalog), and `GET /task/detail?taskId=…`
(look up any task by id, regardless of skill).

## MCP & tools

A skill is sandboxed to `Read` / `Glob` / `Grep`. To give one more power, drop a
`.claude/skills/<name>/.mcp.json` sidecar (standard `{ "mcpServers": { … } }` format);
its tools become available to that skill only. Servers in `./.claude/mcp.json` are global
(visible to every skill); the two are merged, skill winning on a name collision.

Secrets go in env via `${VAR}` placeholders — never commit them into `SKILL.md` or the
sidecar. To consume a request header inside a tool, declare `"HTTP_<NAME>": ""` in the
server's `env`; Estival overwrites only declared keys with the request's header value, so
e.g. an `Authorization` header reaches the tool as `HTTP_AUTHORIZATION` without ever
entering the prompt.

## Configuration

Copy `.env.example` to `.env`. Key vars (full list in `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | — | Dir with Agent SDK credentials (`~` expanded at startup). |
| `PORT` | `3000` | HTTP listen port. |
| `MAX_CONCURRENCY` / `MAX_QUEUE` | `4` / `20` | Concurrent runs / queue depth before 503. |
| `AGENT_TIMEOUT_MS` | `120000` | Per-run wall-clock budget. |
| `AGENT_MAX_TURNS` | `10` | Max turns per run (`0` = unlimited). |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `text` | `debug`<`info`<`warn`<`error`; `text` or `json`. |
| `DATABASE_URL` | — | Enables async endpoints; absent → they 503. |

## Docker

```bash
cp .env.example .env                 # set CLAUDE_CONFIG_DIR etc.
docker compose up --build            # estival only
docker compose --profile db up       # also start postgres for async tasks
```

The image bakes only `src/` + `node_modules`; your `.claude` (skills) and Agent SDK
credentials are mounted read-only, so editing a skill needs no rebuild.

## Development

```bash
pnpm install
pnpm dev          # node --import tsx/esm --watch src/index.ts
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
```

## Architecture

```
HTTP request ─▶ skill-registry ─▶ validate params ─▶ semaphore (concurrency)
                                                          │
                                                          ▼
                                       agent.runAgent ─▶ Claude Agent SDK query()
                                                          │  read-only sandbox + skill MCP
                                                          ▼
                                       JSON-schema-validated structured_output ─▶ response
```

Core modules (all in `src/`): `skill-scanner` (parse frontmatter) · `skill-registry`
(discover + watch) · `validate` (params) · `agent` (run the SDK, enforce output) ·
`mcp` (resolve + merge servers) · `concurrency` (semaphore) · `async-tasks` + `task-store`
+ `db` (Postgres-backed submit/poll) · `request-adapter` + `oss-download` + `file-cleanup`
(uploads / file params) · `http-env` (header → env) · `logger` · `config`.

## License

MIT — see [LICENSE](./LICENSE).
