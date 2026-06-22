import { describe, it, expect } from 'vitest';
import { createTaskStore } from '../task-store.js';
import type { DbClient } from '../db.js';

// Fake DbClient：记录每次 query 的 SQL 与参数，并按预设返回 rows。
function fakeClient(rowsForNextQuery: unknown[][] = []) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  let i = 0;
  const client: DbClient = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      const rows = rowsForNextQuery[i++] ?? [];
      return { rows };
    },
  };
  return { client, calls };
}

describe('TaskStore.migrate', () => {
  it('runs CREATE TABLE IF NOT EXISTS', async () => {
    const { client, calls } = fakeClient();
    await createTaskStore(client).migrate();
    expect(calls[0].text).toContain('CREATE TABLE IF NOT EXISTS tasks');
  });
});

describe('TaskStore.create', () => {
  it('inserts a pending row and returns a uuid', async () => {
    const { client, calls } = fakeClient();
    const id = await createTaskStore(client).create('scene-extractor', { file: 'a.md' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].text).toContain('INSERT INTO tasks');
    expect(calls[0].params?.[1]).toBe('scene-extractor');
    expect(calls[0].params?.[2]).toBe('pending');
    expect(JSON.parse(calls[0].params?.[3] as string)).toEqual({ file: 'a.md' });
  });
});

describe('TaskStore.markRunning', () => {
  it('sets status=running and started_at', async () => {
    const { client, calls } = fakeClient();
    await createTaskStore(client).markRunning('id1');
    expect(calls[0].text).toContain("status='running'");
    expect(calls[0].text).toContain('started_at=now()');
    expect(calls[0].params).toEqual(['id1']);
  });
});

describe('TaskStore.markDone', () => {
  it('writes success row with data/cost/turns', async () => {
    const { client, calls } = fakeClient();
    await createTaskStore(client).markDone(
      'id1',
      { success: true, data: { summary: 'hi' }, cost: 0.02, turns: 3 },
      'sess-1',
    );
    const p = calls[0].params!;
    expect(p[0]).toBe('success');
    expect(JSON.parse(p[1] as string)).toEqual({ summary: 'hi' });
    expect(p[2]).toBe(0.02);
    expect(p[3]).toBe(3);
    expect(p[4]).toBeNull();
    expect(p[5]).toBeNull();
    expect(p[6]).toBe('sess-1');
    expect(p[7]).toBe('id1');
  });

  it('writes failed row with error/detail and null result', async () => {
    const { client, calls } = fakeClient();
    await createTaskStore(client).markDone('id1', {
      success: false,
      error: 'boom',
      detail: 'why',
    });
    const p = calls[0].params!;
    expect(p[0]).toBe('failed');
    expect(p[1]).toBeNull();
    expect(p[4]).toBe('boom');
    expect(p[5]).toBe('why');
  });
});

describe('TaskStore.get', () => {
  it('returns the row or null', async () => {
    const row = { id: 'id1', skill: 's', status: 'success' };
    const { client } = fakeClient([[row]]);
    expect(await createTaskStore(client).get('id1')).toEqual(row);

    const { client: empty } = fakeClient([[]]);
    expect(await createTaskStore(empty).get('missing')).toBeNull();
  });
});

describe('TaskStore.recoverOrphans', () => {
  it('marks pending/running as failed and returns count', async () => {
    const { client, calls } = fakeClient([[{ id: 'a' }, { id: 'b' }]]);
    const n = await createTaskStore(client).recoverOrphans();
    expect(n).toBe(2);
    expect(calls[0].text).toContain("status='failed'");
    expect(calls[0].text).toContain("status IN ('pending','running')");
  });
});

describe('TaskStore.sweep', () => {
  it('deletes old finished rows and returns count', async () => {
    const { client, calls } = fakeClient([[{ id: 'a' }, { id: 'b' }, { id: 'c' }]]);
    const n = await createTaskStore(client).sweep(24);
    expect(n).toBe(3);
    expect(calls[0].text).toContain('DELETE FROM tasks');
    expect(calls[0].text).toContain("status IN ('success','failed')");
    expect(calls[0].params).toEqual(['24']);
  });
});
