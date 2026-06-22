import { randomUUID } from 'node:crypto';
import type { DbClient } from './db.js';
import type { QueryResponse } from './types.js';

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed';

export interface TaskRow {
  id: string;
  skill: string;
  status: TaskStatus;
  params: unknown;
  result: unknown;
  cost: number | null;
  turns: number | null;
  error: string | null;
  detail: string | null;
  session_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id          text PRIMARY KEY,
  skill       text NOT NULL,
  status      text NOT NULL,
  params      jsonb,
  result      jsonb,
  cost        double precision,
  turns       integer,
  error       text,
  detail      text,
  session_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
`;

export interface TaskStore {
  migrate(): Promise<void>;
  create(skill: string, params: Record<string, unknown>): Promise<string>;
  markRunning(id: string): Promise<void>;
  markDone(id: string, result: QueryResponse, sessionId?: string): Promise<void>;
  get(id: string): Promise<TaskRow | null>;
  recoverOrphans(): Promise<number>;
  sweep(ttlHours: number): Promise<number>;
}

export function createTaskStore(client: DbClient): TaskStore {
  return {
    async migrate() {
      await client.query(MIGRATION_SQL);
    },

    async create(skill, params) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO tasks (id, skill, status, params) VALUES ($1, $2, $3, $4)`,
        [id, skill, 'pending', JSON.stringify(params)],
      );
      return id;
    },

    async markRunning(id) {
      await client.query(
        `UPDATE tasks SET status='running', started_at=now() WHERE id=$1`,
        [id],
      );
    },

    async markDone(id, result, sessionId) {
      const status: TaskStatus = result.success ? 'success' : 'failed';
      await client.query(
        `UPDATE tasks
            SET status=$1, result=$2, cost=$3, turns=$4, error=$5, detail=$6,
                session_id=$7, finished_at=now()
          WHERE id=$8`,
        [
          status,
          result.data === undefined ? null : JSON.stringify(result.data),
          result.cost ?? null,
          result.turns ?? null,
          result.error ?? null,
          result.detail ?? null,
          sessionId ?? null,
          id,
        ],
      );
    },

    async get(id) {
      const { rows } = await client.query(`SELECT * FROM tasks WHERE id=$1`, [id]);
      return (rows[0] as TaskRow) ?? null;
    },

    async recoverOrphans() {
      const { rows } = await client.query(
        `UPDATE tasks
            SET status='failed', error='interrupted by restart', finished_at=now()
          WHERE status IN ('pending','running')
        RETURNING id`,
      );
      return rows.length;
    },

    async sweep(ttlHours) {
      const { rows } = await client.query(
        `DELETE FROM tasks
          WHERE status IN ('success','failed')
            AND finished_at < now() - ($1 || ' hours')::interval
        RETURNING id`,
        [String(ttlHours)],
      );
      return rows.length;
    },
  };
}
