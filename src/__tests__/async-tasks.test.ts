import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDetailResponse, submitTask, type SubmitDeps } from '../async-tasks.js';
import type { TaskRow, TaskStore } from '../task-store.js';
import { createSemaphore } from '../concurrency.js';
import type { QueryResponse, SkillConfig, UploadedFileMeta } from '../types.js';

/** Write a real temp file and return its UploadedFileMeta, for cleanup assertions. */
function tempFile(): UploadedFileMeta {
  const dir = mkdtempSync(join(tmpdir(), 'submit-test-'));
  const path = join(dir, 'doc.pdf');
  writeFileSync(path, 'x');
  return { fieldname: 'files', originalname: 'doc.pdf', path, size: 1, source: 'oss' };
}

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 'id1',
    skill: 'scene-extractor',
    status: 'success',
    params: { file: 'a.md' },
    result: { summary: 'hi' },
    cost: 0.02,
    turns: 3,
    error: null,
    detail: null,
    session_id: 'sess-1',
    created_at: '2026-06-16T00:00:00Z',
    started_at: '2026-06-16T00:00:01Z',
    finished_at: '2026-06-16T00:00:05Z',
    ...over,
  };
}

describe('buildDetailResponse', () => {
  it('400 when taskId missing', () => {
    const r = buildDetailResponse(null, 'scene-extractor', '');
    expect(r.status).toBe(400);
  });

  it('404 when row not found', () => {
    const r = buildDetailResponse(null, 'scene-extractor', 'id1');
    expect(r.status).toBe(404);
  });

  it('404 when skill does not match the row', () => {
    const r = buildDetailResponse(row({ skill: 'other' }), 'scene-extractor', 'id1');
    expect(r.status).toBe(404);
  });

  it('200 regardless of skill when skillName omitted (generic /task/detail)', () => {
    const r = buildDetailResponse(row({ skill: 'other' }), undefined, 'id1');
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).skill).toBe('other');
  });

  it('still 404 on missing row when skillName omitted', () => {
    const r = buildDetailResponse(null, undefined, 'id1');
    expect(r.status).toBe(404);
  });

  it('200 with QueryResponse fields on success', () => {
    const r = buildDetailResponse(row(), 'scene-extractor', 'id1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      taskId: 'id1',
      skill: 'scene-extractor',
      status: 'success',
      data: { summary: 'hi' },
      cost: 0.02,
      turns: 3,
      createdAt: '2026-06-16T00:00:00Z',
      finishedAt: '2026-06-16T00:00:05Z',
    });
  });

  it('200 without result fields while pending', () => {
    const r = buildDetailResponse(
      row({ status: 'pending', result: null, cost: null, turns: null, finished_at: null, started_at: null }),
      'scene-extractor',
      'id1',
    );
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).status).toBe('pending');
    expect((r.body as Record<string, unknown>).data).toBeUndefined();
  });

  it('200 with error/detail on failed', () => {
    const r = buildDetailResponse(
      row({ status: 'failed', result: null, error: 'boom', detail: 'why' }),
      'scene-extractor',
      'id1',
    );
    expect(r.body).toMatchObject({ status: 'failed', error: 'boom', detail: 'why' });
  });
});

function fakeStore() {
  const events: string[] = [];
  const store: TaskStore = {
    migrate: vi.fn(),
    create: vi.fn(async () => 'task-1'),
    markRunning: vi.fn(async () => { events.push('running'); }),
    markDone: vi.fn(async (_id, r: QueryResponse) => { events.push(`done:${r.success}`); }),
    get: vi.fn(),
    recoverOrphans: vi.fn(),
    sweep: vi.fn(),
  };
  return { store, events };
}

const submitSkill: SkillConfig = {
  name: 'scene-extractor',
  description: 'd',
  params: { required: [], optional: [] },
  output: {},
};

describe('submitTask', () => {
  it('creates a pending task (auth stripped) and returns taskId immediately', async () => {
    const { store } = fakeStore();
    const runAgent: SubmitDeps['runAgent'] = vi.fn(async () => ({ success: true, data: { ok: 1 } }));
    const { taskId } = await submitTask({
      skill: submitSkill,
      body: { file: 'a.md', authorization: 'Bearer secret' },
      store,
      runAgent,
      semaphore: createSemaphore(2, 4),
      inflight: new Set(),
    });
    expect(taskId).toBe('task-1');
    expect(vi.mocked(store.create).mock.calls[0][1]).toEqual({ file: 'a.md' });
  });

  it('runs agent in background and marks done success', async () => {
    const { store, events } = fakeStore();
    const runAgent: SubmitDeps['runAgent'] = vi.fn(async () => ({ success: true, data: { ok: 1 } }));
    const inflight = new Set<AbortController>();
    const { done } = await submitTask({
      skill: submitSkill,
      body: { file: 'a.md' },
      httpEnv: { HTTP_AUTHORIZATION: 'Bearer secret' },
      store,
      runAgent,
      semaphore: createSemaphore(2, 4),
      inflight,
    });
    await done;
    // The request headers reach the background run via httpEnv (not via body/DB).
    expect(vi.mocked(runAgent).mock.calls[0][0].httpEnv).toEqual({ HTTP_AUTHORIZATION: 'Bearer secret' });
    expect(events).toEqual(['running', 'done:true']);
    expect(inflight.size).toBe(0);
  });

  it('marks failed when runAgent throws', async () => {
    const { store, events } = fakeStore();
    const runAgent: SubmitDeps['runAgent'] = vi.fn(async () => { throw new Error('boom'); });
    const { done } = await submitTask({
      skill: submitSkill,
      body: { file: 'a.md' },
      store,
      runAgent,
      semaphore: createSemaphore(2, 4),
      inflight: new Set(),
    });
    await done;
    expect(events).toEqual(['running', 'done:false']);
    expect(vi.mocked(store.markDone).mock.calls[0][1].success).toBe(false);
  });

  it('deletes resolved temp files after a successful run', async () => {
    const { store } = fakeStore();
    const f = tempFile();
    expect(existsSync(f.path)).toBe(true);
    const runAgent: SubmitDeps['runAgent'] = vi.fn(async () => ({ success: true, data: {} }));
    const { done } = await submitTask({
      skill: submitSkill,
      body: { files: [{ id: 'f1', path: f.path }] },
      store,
      runAgent,
      semaphore: createSemaphore(2, 4),
      inflight: new Set(),
      files: [f],
    });
    await done;
    expect(existsSync(f.path)).toBe(false);
  });

  it('deletes resolved temp files even when the run fails', async () => {
    const { store } = fakeStore();
    const f = tempFile();
    const runAgent: SubmitDeps['runAgent'] = vi.fn(async () => { throw new Error('boom'); });
    const { done } = await submitTask({
      skill: submitSkill,
      body: { files: [{ id: 'f1', path: f.path }] },
      store,
      runAgent,
      semaphore: createSemaphore(2, 4),
      inflight: new Set(),
      files: [f],
    });
    await done;
    expect(existsSync(f.path)).toBe(false);
  });
});
