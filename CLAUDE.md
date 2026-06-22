# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

Estival is an HTTP framework wrapping the Claude Agent SDK. Each `.claude/skills/*/SKILL.md`
defines a skill; the server discovers them at startup and exposes one endpoint per skill.
`src/skill-scanner.ts` parses the YAML frontmatter (name, description, params, output JSON
schema); `src/agent.ts` runs the agent via the SDK `query()` and enforces structured output
against that schema.

Endpoints per skill: `POST /skills/{name}` (sync), `POST /skills/{name}/stream` (SSE),
`POST /skills/{name}/submit` + `GET /skills/{name}/task/detail` (async, needs `DATABASE_URL`).
Global: `GET /health`, `GET /skills`, `GET /task/detail`.

The framework is generic: there is no business logic in `src/`. Skills (in `.claude/skills/`)
and their MCP sidecars are the only app-specific surface. `examples/.claude` holds a starter
`hello` skill; `npx estival init` copies it into a consumer's project.

## Commands

Package manager is **pnpm**. Node 18+ (22+ for the Docker image).

- Run: `pnpm start` (`node --import tsx/esm src/index.ts`) — also `bin/estival.mjs` (`estival` CLI)
- Watch: `pnpm dev`
- Typecheck: `pnpm typecheck` (`tsc --noEmit`)
- Lint: `pnpm lint` (`eslint .`, flat config + type-aware rules)
- Test: `pnpm test` (`vitest run`); single file: `pnpm vitest run src/__tests__/agent.test.ts`
- Build: `pnpm build` (`tsc`)

## Gotchas

- **`CLAUDE_CONFIG_DIR` `~` expansion is load-bearing.** `src/config.ts` resolves `~` to an
  absolute path at startup. The SDK spawns subprocesses that inherit this env var and cannot
  expand `~` themselves — do not remove the normalization.
- **SKILL.md frontmatter is the public API.** Editing a skill's params or output schema
  changes the HTTP contract for `POST /skills/{name}`. Treat schema edits as breaking.
- **Skills run in a read-only sandbox by default.** Agent `permissionMode` auto-allows only
  Read/Glob/Grep. A skill writes files or runs bash only if it opts in via a
  `.claude/skills/<name>/.mcp.json` sidecar; `src/agent.ts` then adds the SDK wildcard
  `mcp__<server>__*` to `allowedTools`. Global servers come from `.claude/mcp.json`; the two
  merge (skill wins on collision). Secrets use `${VAR}` placeholders — an unset `${VAR}`
  drops the whole server at load (with a warn).
- **Request headers reach MCP as `HTTP_*` env, opt-in per header.** Each header is offered as
  `HTTP_<UPPER_SNAKE>`; `src/agent.ts` (`injectHttpEnv`) overwrites only the `HTTP_*` keys a
  server **declares** in its `.mcp.json` env. Undeclared headers never reach the subprocess,
  and headers never reach the model (they ride a separate `httpEnv` field, not params).
- **The bin CLI runs against the consumer's cwd.** `bin/estival.mjs` spawns the engine from
  the package dir but inherits `process.cwd()`, so the server scans `<cwd>/.claude/skills`.

## Conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`). Work on a branch, PR to `main`.
- TypeScript strict mode, ES modules (`"type": "module"`), NodeNext resolution. No formatter
  configured — match surrounding style.
