import { Pool } from 'pg';

/** Store 依赖的最小 pg 接口；真实实现是 pg.Pool，测试用 fake。 */
export interface DbClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** 建一个 pg 连接池（实现 DbClient）。调用方负责在关机时 end()。 */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}
