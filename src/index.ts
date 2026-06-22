import {
  PORT,
  CLAUDE_CONFIG_DIR,
  MAX_CONCURRENCY,
  MAX_QUEUE,
  MAX_BODY,
  GLOBAL_MCP_PATH,
  LOG_LEVEL,
  LOG_FORMAT,
  DATABASE_URL,
  TASK_TTL_HOURS,
  FILES_DIR,
  FILE_TTL_HOURS,
} from './config.js';
import { createPool } from './db.js';
import { createTaskStore, type TaskStore } from './task-store.js';
import { submitTask, buildDetailResponse } from './async-tasks.js';
import { loadGlobalMcp } from './mcp.js';
import { join } from 'node:path';
import { unlink } from 'node:fs';
import express from 'express';
import multer from 'multer';
import { createSkillRegistry } from './skill-registry.js';
import { runAgent, streamAgent } from './agent.js';
import { httpEnvFromHeaders } from './http-env.js';
import { createSemaphore, SaturatedError } from './concurrency.js';
import { validateParams } from './validate.js';
import { logger } from './logger.js';
import { normalizeRequest } from './request-adapter.js';
import { startFileSweep } from './file-cleanup.js';
import type { UploadedFileMeta } from './types.js';

const app = express();
app.use((req, _res, next) => {
  if (req.is('multipart/form-data')) return next();
  express.json({ limit: MAX_BODY })(req, _res, next);
});

const SKILLS_DIR = join(process.cwd(), '.claude', 'skills');

logger.info('starting', { logLevel: LOG_LEVEL, logFormat: LOG_FORMAT });

const registry = createSkillRegistry(SKILLS_DIR);
const globalMcp = loadGlobalMcp(GLOBAL_MCP_PATH);
const globalMcpNames = Object.keys(globalMcp);
if (globalMcpNames.length > 0) {
  logger.info('global MCP servers loaded', { servers: globalMcpNames });
}
const semaphore = createSemaphore(MAX_CONCURRENCY, MAX_QUEUE);

// 异步任务存储：DATABASE_URL 缺失则 store 为 null，submit/detail 返回 503。
let taskStore: TaskStore | null = null;
let pool: ReturnType<typeof createPool> | null = null;
if (DATABASE_URL) {
  pool = createPool(DATABASE_URL);
  const store = createTaskStore(pool);
  // Publish `taskStore` only after migrate + recoverOrphans finish, so a request
  // racing startup gets a clean 503 ("disabled") rather than a 500 from querying
  // a not-yet-created table. On init failure it stays null → endpoints stay 503.
  store.migrate()
    .then(() => store.recoverOrphans())
    .then((n) => {
      if (n > 0) logger.warn('recovered orphan tasks (marked failed)', { count: n });
      taskStore = store;
      logger.info('async task store ready');
    })
    .catch((err) => {
      logger.error('task store init failed; async endpoints disabled', { err });
    });

  if (TASK_TTL_HOURS > 0) {
    // Sweep period = TTL, capped at 1h so a large TTL (e.g. 720h) still prunes hourly
    // rather than once a month. Sub-hourly TTLs sweep at their own (shorter) cadence.
    const sweepMs = Math.min(TASK_TTL_HOURS, 1) * 60 * 60 * 1000;
    setInterval(() => {
      taskStore?.sweep(TASK_TTL_HOURS)
        .then((n) => { if (n > 0) logger.info('swept old tasks', { count: n }); })
        .catch((err) => logger.warn('task sweep failed', { err }));
    }, sweepMs).unref();
  }
} else {
  logger.info('DATABASE_URL not set; async task endpoints disabled');
}

// In-flight controllers, aborted on shutdown so subprocesses don't linger.
const inflight = new Set<AbortController>();

// Per-request id, so a request's lifecycle lines (received → done) correlate in the log.
let reqSeq = 0;

const initialSkills = registry.list();
if (initialSkills.length === 0) {
  logger.warn('no skills found', { dir: SKILLS_DIR });
} else {
  logger.info('skills loaded', { skills: initialSkills.map((s) => s.name) });
}

if (CLAUDE_CONFIG_DIR) {
  logger.info('config', { CLAUDE_CONFIG_DIR });
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/skills', (_req, res) => {
  res.json(
    registry.list().map((s) => ({
      name: s.name,
      description: s.description,
      endpoints: {
        sync: `POST /skills/${s.name}`,
        stream: `POST /skills/${s.name}/stream`,
        submit: `POST /skills/${s.name}/submit`,
        detail: `GET /skills/${s.name}/task/detail?taskId=...`,
      },
      params: s.params,
      output: s.output,
      mcpServers: Object.keys(s.mcpServers ?? {}),
    })),
  );
});

// Forwarding HTTP headers to MCP is infra, not skill-authored params: every header
// is offered as `HTTP_<NAME>` env, and a skill's MCP server opts in per header by
// declaring that key in its `.mcp.json` env (see injectHttpEnv). Headers never reach
// the model; skills do NOT declare header params.

app.post('/skills/:name', async (req, res) => {
  const skill = registry.get(req.params.name);
  if (!skill) {
    res.status(404).json({ error: `skill '${req.params.name}' not found` });
    return;
  }
  const requestId = `req#${++reqSeq}`;
  const rlog = logger.child({ req: requestId, skill: skill.name });
  const start = Date.now();
  let uploadedFiles: UploadedFileMeta[] = [];
  const controller = new AbortController();
  inflight.add(controller);
  try {
    const { params: body, files } = await normalizeRequest(req, skill, req.headers.authorization);
    uploadedFiles = files;
    const httpEnv = httpEnvFromHeaders(req.headers);
    // Param KEYS only — values may carry secrets (authorization), never logged.
    rlog.info('received', { mode: 'sync', paramKeys: Object.keys(body) });

    const valid = validateParams(skill, body);
    if (!valid.ok) {
      rlog.warn('invalid params', { error: valid.error });
      res.status(400).json({ error: valid.error });
      return;
    }

    const result = await semaphore.run(() =>
      runAgent({ skill, params: body, controller, globalMcp, requestId, httpEnv }),
    );
    const ms = Date.now() - start;
    if (!result.success) {
      rlog.warn('failed', { ms, error: result.error, detail: result.detail });
      res.status(500).json(result);
      return;
    }
    rlog.info('done', { ms, cost: result.cost, turns: result.turns });
    res.json(result);
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof SaturatedError) {
      rlog.warn('saturated', { ms, status: 503 });
      res.status(503).json({ success: false, error: 'server busy, retry later' });
      return;
    }
    if (err instanceof Error && err.message.includes('OSS')) {
      rlog.warn('oss error', { ms, error: err.message });
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof multer.MulterError || (err as any)?.code === 'LIMIT_FILE_SIZE') {
      rlog.warn('upload error', { ms, error: (err as Error).message });
      res.status(413).json({ success: false, error: (err as Error).message });
      return;
    }
    rlog.error('error', { ms, err });
    res.status(500).json({ success: false, error: 'internal error' });
  } finally {
    inflight.delete(controller);
    for (const f of uploadedFiles) {
      unlink(f.path, () => {});
    }
  }
});

app.post('/skills/:name/stream', async (req, res) => {
  const skill = registry.get(req.params.name);
  if (!skill) {
    res.status(404).json({ error: `skill '${req.params.name}' not found` });
    return;
  }
  const requestId = `req#${++reqSeq}`;
  const rlog = logger.child({ req: requestId, skill: skill.name });
  const start = Date.now();
  let uploadedFiles: UploadedFileMeta[] = [];
  const controller = new AbortController();
  inflight.add(controller);
  // Abort the agent run when the client disconnects, so it stops spending.
  // Listen on `res`, NOT `req`: on modern Node the request IncomingMessage emits
  // 'close' as soon as its body is fully read (autoDestroy), which for a small
  // JSON body is immediate — aborting the run before it starts. The response
  // 'close' fires on real disconnect; `writableFinished` distinguishes that from
  // our own res.end() in the finally below.
  res.on('close', () => {
    if (!res.writableFinished && !controller.signal.aborted) {
      rlog.debug('client disconnected, aborting');
      controller.abort();
    }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { params: body, files } = await normalizeRequest(req, skill, req.headers.authorization);
    uploadedFiles = files;
    const httpEnv = httpEnvFromHeaders(req.headers);
    rlog.info('received', { mode: 'stream', paramKeys: Object.keys(body) });

    const valid = validateParams(skill, body);
    if (!valid.ok) {
      rlog.warn('invalid params', { error: valid.error });
      res.write(`data: ${JSON.stringify({ type: 'error', error: valid.error })}\n\n`);
      return;
    }

    await semaphore.run(async () => {
      for await (const message of streamAgent({ skill, params: body, controller, globalMcp, requestId, httpEnv })) {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      }
    });
    rlog.info('done', { mode: 'stream', ms: Date.now() - start });
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof SaturatedError) {
      rlog.warn('saturated', { ms, status: 503 });
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'server busy, retry later' })}\n\n`);
    } else if (err instanceof Error && err.message.includes('OSS')) {
      rlog.warn('oss error', { ms, error: err.message });
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } else if (err instanceof multer.MulterError || (err as any)?.code === 'LIMIT_FILE_SIZE') {
      rlog.warn('upload error', { ms, error: (err as Error).message });
      res.write(`data: ${JSON.stringify({ type: 'error', error: (err as Error).message })}\n\n`);
    } else {
      rlog.error('error', { ms, err });
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'internal error' })}\n\n`);
    }
  } finally {
    inflight.delete(controller);
    for (const f of uploadedFiles) {
      unlink(f.path, () => {});
    }
    res.end();
  }
});

app.post('/skills/:name/submit', async (req, res) => {
  const skill = registry.get(req.params.name);
  if (!skill) {
    res.status(404).json({ error: `skill '${req.params.name}' not found` });
    return;
  }
  if (!taskStore) {
    res.status(503).json({ error: 'async tasks disabled (DATABASE_URL not set)' });
    return;
  }
  const requestId = `req#${++reqSeq}`;
  const rlog = logger.child({ req: requestId, skill: skill.name });
  // Resolve resolve:file params (OSS download / multipart) BEFORE returning 202 —
  // same as the sync/stream paths. The task then runs the agent on local paths.
  // Temp-file cleanup is handed to submitTask (runs after the background run); on any
  // path that does NOT create a task we unlink here, since no run will own them.
  let files: UploadedFileMeta[] = [];
  try {
    const norm = await normalizeRequest(req, skill, req.headers.authorization);
    files = norm.files;
    const body = norm.params;
    const httpEnv = httpEnvFromHeaders(req.headers);
    rlog.info('received', { mode: 'submit', paramKeys: Object.keys(body) });

    const valid = validateParams(skill, body);
    if (!valid.ok) {
      rlog.warn('invalid params', { error: valid.error });
      for (const f of files) unlink(f.path, () => {});
      res.status(400).json({ error: valid.error });
      return;
    }

    const { taskId } = await submitTask({
      skill,
      body,
      store: taskStore,
      runAgent,
      semaphore,
      inflight,
      globalMcp,
      requestId,
      httpEnv,
      files,
      onError: (err, id) => rlog.error('background task error', { taskId: id, err }),
    });
    rlog.info('submitted', { taskId });
    res.status(202).json({ taskId });
  } catch (err) {
    // No task was created on this path, so the downloaded/uploaded temp files are ours to clean.
    for (const f of files) unlink(f.path, () => {});
    if (err instanceof Error && err.message.includes('OSS')) {
      rlog.warn('oss error', { error: err.message });
      res.status(400).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof multer.MulterError || (err as any)?.code === 'LIMIT_FILE_SIZE') {
      rlog.warn('upload error', { error: (err as Error).message });
      res.status(413).json({ error: (err as Error).message });
      return;
    }
    rlog.error('submit failed', { err });
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/skills/:name/task/detail', async (req, res) => {
  const skill = registry.get(req.params.name);
  if (!skill) {
    res.status(404).json({ error: `skill '${req.params.name}' not found` });
    return;
  }
  if (!taskStore) {
    res.status(503).json({ error: 'async tasks disabled (DATABASE_URL not set)' });
    return;
  }
  const requestId = `req#${++reqSeq}`;
  const rlog = logger.child({ req: requestId, skill: skill.name });
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
  try {
    const row = taskId ? await taskStore.get(taskId) : null;
    const { status, body } = buildDetailResponse(row, skill.name, taskId);
    res.status(status).json(body);
  } catch (err) {
    rlog.error('task detail failed', { taskId, err });
    res.status(500).json({ error: 'internal error' });
  }
});

// 通用任务查询：不带 skill 名，按 taskId 全局查任意 skill 的任务。
// 响应体含 `skill` 字段，调用方据此区分任务归属。
app.get('/task/detail', async (req, res) => {
  if (!taskStore) {
    res.status(503).json({ error: 'async tasks disabled (DATABASE_URL not set)' });
    return;
  }
  const requestId = `req#${++reqSeq}`;
  const rlog = logger.child({ req: requestId });
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : '';
  try {
    const row = taskId ? await taskStore.get(taskId) : null;
    const { status, body } = buildDetailResponse(row, undefined, taskId);
    res.status(status).json(body);
  } catch (err) {
    rlog.error('task detail failed', { taskId, err });
    res.status(500).json({ error: 'internal error' });
  }
});

app.use((req, res) => {
  const skillName = req.path.match(/^\/skills\/([^/]+)/)?.[1];
  if (skillName) {
    res.status(404).json({ error: `skill '${skillName}' not found` });
  } else {
    res.status(404).json({ error: 'not found' });
  }
});

const server = app.listen(PORT, () => {
  logger.info('listening', { port: PORT });
});

const stopSweep = startFileSweep(FILES_DIR, FILE_TTL_HOURS, 6 * 3600_000);

function shutdown(signal: string): void {
  stopSweep();
  logger.info('shutting down', { signal, inflight: inflight.size });
  registry.close();
  // Close the HTTP server, then the pool — NOT before. Aborting inflight runs makes
  // their background catch best-effort `markDone(failed)`; closing the pool first would
  // guarantee that write fails (leaving the row 'running' until next boot's recovery).
  server.close(() => {
    pool?.end().catch(() => {});
    process.exit(0);
  });
  for (const controller of inflight) controller.abort();
  // Failsafe if connections don't drain promptly.
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
