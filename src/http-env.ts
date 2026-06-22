/**
 * 把 HTTP 请求头转成可注入 MCP server 的环境变量。
 *
 * 约定（CGI 风格）：头名大写、连字符转下划线、统一加 `HTTP_` 前缀，
 * 如 `Authorization` → `HTTP_AUTHORIZATION`、`X-Tenant-Id` → `HTTP_X_TENANT_ID`。
 * 这里收集**全部**请求头；实际注入哪些由各 server 在 `.mcp.json` 的 `env` 里声明的
 * `HTTP_*` 占位键决定（见 agent.ts 的 injectHttpEnv），未声明的头不会进任何子进程。
 */

/** 由请求头构造 `HTTP_<UPPER_SNAKE>` → 值 的映射。多值头用 `, ` 连接，缺省值跳过。 */
export function httpEnvFromHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = 'HTTP_' + name.toUpperCase().replace(/-/g, '_');
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
