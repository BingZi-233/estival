import { config as loadEnv } from 'dotenv';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

loadEnv({ quiet: true });

/** Expand a leading `~` (home directory) in a path. Only `~` and `~/...` are handled. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// The Agent SDK spawns a subprocess that inherits process.env, so normalizing
// CLAUDE_CONFIG_DIR here (with `~` expanded to an absolute path) is enough for
// the SDK to pick it up — no per-call wiring needed.
if (process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR = expandHome(process.env.CLAUDE_CONFIG_DIR);
}

export const PORT = Number(process.env.PORT ?? '3000');
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

/** Max agent runs executing concurrently before requests queue. */
export const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? '4');
/** Max requests allowed to wait for a slot; beyond this the server returns 503. */
export const MAX_QUEUE = Number(process.env.MAX_QUEUE ?? '20');
/** Wall-clock budget for a single agent run, in milliseconds. */
export const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? '120000');
/**
 * Max agent turns per run. `0` (or negative) means unlimited: `maxTurns` is then
 * omitted from the SDK options so the `--max-turns` flag is never emitted and the
 * run continues until the agent stops on its own (still bounded by AGENT_TIMEOUT_MS).
 */
export const AGENT_MAX_TURNS = Number(process.env.AGENT_MAX_TURNS ?? '10');
/** Max request body size accepted by express.json(). */
export const MAX_BODY = process.env.MAX_BODY ?? '256kb';

/** Shared directory for OSS downloads and uploaded files. */
export const FILES_DIR = (() => {
  if (process.env.FILES_DIR) return expandHome(process.env.FILES_DIR);
  if (process.env.OSS_DOWNLOAD_DIR) return expandHome(process.env.OSS_DOWNLOAD_DIR);
  return join(tmpdir(), 'estival-files');
})();
/** Max single file size for multer (bytes-compatible string). */
export const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE ?? '10mb';
/** OSS download base URL for request-adapter file resolution. */
export const OSS_BASE_URL = process.env.OSS_BASE_URL ?? '';
/** Temp file retention: files older than this are swept. 180 days default. */
export const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS ?? '4320');

/**
 * Minimum log level to emit: `debug` < `info` < `warn` < `error`. Anything below
 * the threshold is dropped. Default `info`; set `LOG_LEVEL=debug` for per-run detail.
 */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
/** Log output format: `text` (human-readable, default) or `json` (one JSON object per line). */
export const LOG_FORMAT = process.env.LOG_FORMAT ?? 'text';

/**
 * Path to the global MCP config file (`{ "mcpServers": {...} }`). Loaded once
 * at startup; absent file means no global servers. `~` is expanded like
 * CLAUDE_CONFIG_DIR.
 */
export const GLOBAL_MCP_PATH = process.env.GLOBAL_MCP_PATH
  ? expandHome(process.env.GLOBAL_MCP_PATH)
  : join(process.cwd(), '.claude', 'mcp.json');

/**
 * Valid skill name: lowercase alphanumeric + dashes, must start alphanumeric.
 * Names flow straight into Express route paths, so anything outside this set
 * risks route injection or collisions.
 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * PostgreSQL 连接串，启用异步任务（submit/detail）所需。未设置时这两个端点返回 503，
 * 同步与 stream 端点不受影响。
 */
export const DATABASE_URL = process.env.DATABASE_URL;

/**
 * 已完成任务行的保留小时数。`0`（默认）= 不清理。>0 时按此周期删除 finished_at 早于
 * now()-interval 的 success/failed 行。
 */
export const TASK_TTL_HOURS = Number(process.env.TASK_TTL_HOURS ?? '0');
