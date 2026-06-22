import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { unlink } from 'node:fs/promises';
import type { TaskRow, TaskStore } from './task-store.js';
import type { SkillConfig, SkillRequest, QueryResponse, UploadedFileMeta } from './types.js';
import type { Semaphore } from './concurrency.js';
import { SaturatedError } from './concurrency.js';

export interface DetailResponse {
  status: number;
  body: unknown;
}

/**
 * 把 TaskRow 映射成 GET .../task/detail 的 HTTP 响应。纯函数，便于单测。
 * `skillName` 省略时（通用 /task/detail 端点）只按 taskId 全局查，不校验归属；
 * 传入时（/skills/:name/task/detail）要求 row.skill 匹配，否则 404。
 */
export function buildDetailResponse(
  row: TaskRow | null,
  skillName: string | undefined,
  taskId: string,
): DetailResponse {
  if (!taskId) {
    return { status: 400, body: { error: 'taskId is required' } };
  }
  if (!row || (skillName !== undefined && row.skill !== skillName)) {
    return { status: 404, body: { error: `task '${taskId}' not found` } };
  }
  const body: Record<string, unknown> = {
    taskId: row.id,
    skill: row.skill,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
  if (row.status === 'success') {
    body.success = true;
    body.data = row.result;
    if (row.cost !== null) body.cost = row.cost;
    if (row.turns !== null) body.turns = row.turns;
  } else if (row.status === 'failed') {
    body.success = false;
    if (row.error !== null) body.error = row.error;
    if (row.detail !== null) body.detail = row.detail;
    if (row.cost !== null) body.cost = row.cost;
    if (row.turns !== null) body.turns = row.turns;
  }
  return { status: 200, body };
}

export interface SubmitDeps {
  skill: SkillConfig;
  body: SkillRequest;
  store: TaskStore;
  runAgent: (req: {
    skill: SkillConfig;
    params: SkillRequest;
    controller: AbortController;
    globalMcp?: Record<string, McpServerConfig>;
    requestId?: string;
    httpEnv?: Record<string, string>;
  }) => Promise<QueryResponse>;
  semaphore: Semaphore;
  inflight: Set<AbortController>;
  globalMcp?: Record<string, McpServerConfig>;
  requestId?: string;
  /** Request HTTP headers as `HTTP_<NAME>` env, forwarded to runAgent for MCP injection. */
  httpEnv?: Record<string, string>;
  /**
   * Temp files resolved for this run (OSS downloads / multipart uploads). Deleted
   * after the background run finishes — NOT in the HTTP handler's `finally`, which
   * would run right after the 202 and unlink them before the agent ever reads them.
   */
  files?: UploadedFileMeta[];
  /** Called when the background run fails. `taskId` lets the caller correlate the log. */
  onError?: (err: unknown, taskId: string) => void;
}

export interface SubmitResult {
  /** 立即可用，供 202 响应返回。 */
  taskId: string;
  /** 后台执行的 promise；生产代码忽略它，测试 await 它。 */
  done: Promise<void>;
}

/**
 * 异步提交：先 await create 拿 taskId（返回给客户端），再 fire-and-forget 后台跑。
 * 令牌走 httpEnv（请求头），随内存传给 runAgent 供 MCP env 注入，不入库。
 */
export async function submitTask(deps: SubmitDeps): Promise<SubmitResult> {
  const { skill, body, store, runAgent, semaphore, inflight, globalMcp, requestId, httpEnv } = deps;

  // 去掉任何遗留的 authorization body 参数后入库；其余入参原样存。
  const { authorization: _omit, ...paramsForDb } = body as Record<string, unknown>;
  void _omit;
  const taskId = await store.create(skill.name, paramsForDb);

  const done = (async () => {
    const controller = new AbortController();
    inflight.add(controller);
    try {
      await semaphore.run(async () => {
        await store.markRunning(taskId);
        const result = await runAgent({ skill, params: body, controller, globalMcp, requestId, httpEnv });
        await store.markDone(taskId, result);
      });
    } catch (err) {
      const result: QueryResponse =
        err instanceof SaturatedError
          ? { success: false, error: 'server busy, retry later' }
          : { success: false, error: 'internal error' };
      await store.markDone(taskId, result).catch(() => {});
      deps.onError?.(err, taskId);
    } finally {
      inflight.delete(controller);
      // Clean up resolved temp files only now the run is over (see SubmitDeps.files).
      // Awaited so `done` settling implies the temp files are gone.
      await Promise.all((deps.files ?? []).map((f) => unlink(f.path).catch(() => {})));
    }
  })();

  return { taskId, done };
}
