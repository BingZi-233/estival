<div align="center">

# 🌻 Estival（盛夏）

**把 [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 的 skill 变成受 schema 约束的 REST 接口。**

放一个 `SKILL.md`，得到一个 API。

[![LINUX DO](https://img.shields.io/badge/LINUX_DO-社区认可-4A90D9?logo=discourse&logoColor=white)](https://linux.do)
[![License](https://img.shields.io/github/license/BingZi-233/estival?color=4A90D9)](https://github.com/BingZi-233/estival/blob/main/LICENSE)
[![Stars](https://img.shields.io/github/stars/BingZi-233/estival?color=EAC54F&logo=github)](https://github.com/BingZi-233/estival/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)

[English](./README.md) | 简体中文

</div>

> 本项目由 [LINUX DO](https://linux.do) 社区孵化并认可。

---

Estival（盛夏）是一个小而偏生产的 Web 框架，用于把 LLM agent 直接发布成普通 HTTP API。
你用一个带 YAML frontmatter 的 Markdown 文件描述一个 skill —— 入参 + 出参 JSON Schema ——
Estival 在启动时发现它并暴露为独立端点。每个请求都在**只读沙箱**里运行 agent，并在返回前
按 skill 声明的 output schema 校验结果。无胶水代码，无逐端点样板。

> *Estival*（形容词）——「盛夏的、属于盛夏的」。本框架从内部的 "scene-agent" 服务中提取而来。

## 为什么用它

- **Skill 即 API。** 一个 `SKILL.md` = 一个端点。frontmatter 本身就是 HTTP 契约（入参 + 出参 schema），每次响应都强校验。
- **默认安全。** skill 只有 `Read` / `Glob` / `Grep`。写文件或执行命令需按 skill 显式经 MCP sidecar 开启。
- **四种调用形态，零额外代码。** 每个 skill 自动获得同步、流式（SSE）、以及（接数据库后）异步提交/轮询端点。
- **为运维而生。** 并发上限 + 排队、单次运行墙钟超时、请求体大小限制、结构化日志、优雅停机、文件上传 + 清理。
- **密钥永不进模型。** 请求头按 skill 显式转发给 MCP server（作为 `HTTP_*` 环境变量）—— bearer token 流向工具，不进 prompt。

## 环境要求

- Node.js 18+（Docker 镜像 / pnpm@11 需 Node 22+）
- 一套 Claude Agent SDK 鉴权（一个含有效凭证的 `CLAUDE_CONFIG_DIR`）
- PostgreSQL —— **仅**异步 `submit`/`detail` 端点需要；同步与流式无需数据库

## 快速开始

```bash
npx estival init      # 脚手架生成 ./.claude/skills/hello + .env
# 编辑 .env → 把 CLAUDE_CONFIG_DIR 指向含 Agent SDK 凭证的目录
npx estival           # 在 :3000 启动服务
```

调用示例 skill：

```bash
curl -s localhost:3000/skills | jq                 # 列出已发现的 skill
curl -s -X POST localhost:3000/skills/hello \
  -H 'content-type: application/json' \
  -d '{"name":"Ada","message":"今天上线一个 agent"}' | jq
```

或作为依赖接入现有项目：

```bash
pnpm add estival
# 把你的 skill 放进 ./.claude/skills，然后：
pnpm estival
```

## 编写 skill

skill 是 `.claude/skills/<name>/` 下含 `SKILL.md` 的目录：

```markdown
---
name: hello
description: 问候调用方并回显一段结构化摘要。
params:
  required:
    - name: name
      type: string
      description: 问候对象。
  optional:
    - name: message
      type: string
      description: 可选的待摘要消息。
output:                       # 任意 JSON Schema；对响应强校验
  type: object
  properties:
    greeting: { type: string }
    summary:  { type: string }
  required: [greeting, summary]
---

# Hello

给 agent 的指令写在这里（纯 Markdown）。返回匹配上面 output schema 的 JSON。
```

- `name` 须匹配 `^[a-z0-9][a-z0-9-]*$`（它会成为路由路径）。
- `params.required` / `params.optional` 校验请求体。
- `output` 是任意 JSON Schema；agent 被强制产出匹配对象。
- frontmatter 加 `enabled: false` 可临时禁用某 skill。
- 带 `resolve: file` 的参数被当作文件引用：multipart 上传或远程引用会先下载到本地路径再运行。

## 端点

每个已加载的 skill `<name>` 暴露：

| 方法与路径 | 模式 | 说明 |
|---|---|---|
| `POST /skills/<name>` | 同步 | 运行并返回校验后的 JSON。 |
| `POST /skills/<name>/stream` | SSE | 以 `data:` 帧流式输出原始 SDK 消息。 |
| `POST /skills/<name>/submit` | 异步 | 返回 `202 { taskId }`，需 `DATABASE_URL`。 |
| `GET  /skills/<name>/task/detail?taskId=…` | 异步 | 轮询任务状态/结果。 |

另有全局端点：`GET /health`、`GET /skills`（目录）、`GET /task/detail?taskId=…`（按 id 查任意 skill 的任务）。

## MCP 与工具

skill 被沙箱限制为 `Read` / `Glob` / `Grep`。要赋予更多能力，放一个
`.claude/skills/<name>/.mcp.json` sidecar（标准 `{ "mcpServers": { … } }` 格式），其工具
只对该 skill 可见。`./.claude/mcp.json` 中的 server 为全局（对所有 skill 可见）；两者合并，
重名时 skill 优先。

密钥经 env 用 `${VAR}` 占位注入 —— 切勿写进 `SKILL.md` 或 sidecar。要在工具内消费某请求头，
在 server 的 `env` 里声明 `"HTTP_<NAME>": ""`；Estival 只覆盖被声明的键，故如 `Authorization`
头会以 `HTTP_AUTHORIZATION` 到达工具，而绝不进入 prompt。

## 配置

把 `.env.example` 复制为 `.env`。关键变量（完整列表见 `.env.example`）：

| 变量 | 默认 | 用途 |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | — | 含 Agent SDK 凭证的目录（启动时展开 `~`）。 |
| `PORT` | `3000` | HTTP 监听端口。 |
| `MAX_CONCURRENCY` / `MAX_QUEUE` | `4` / `20` | 并发运行数 / 排队深度，超出返回 503。 |
| `AGENT_TIMEOUT_MS` | `120000` | 单次运行墙钟预算。 |
| `AGENT_MAX_TURNS` | `10` | 单次运行最大回合（`0` = 不限制）。 |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `text` | `debug`<`info`<`warn`<`error`；`text` 或 `json`。 |
| `DATABASE_URL` | — | 启用异步端点；缺失则它们返回 503。 |

## Docker

```bash
cp .env.example .env                 # 设置 CLAUDE_CONFIG_DIR 等
docker compose up --build            # 仅 estival
docker compose --profile db up       # 同时起 postgres 跑异步任务
```

镜像只烤进 `src/` + `node_modules`；你的 `.claude`（skill）与 Agent SDK 凭证以只读挂载，
故改 skill 无需重建镜像。

## 开发

```bash
pnpm install
pnpm dev          # node --import tsx/esm --watch src/index.ts
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
```

## 许可

MIT —— 见 [LICENSE](./LICENSE)。
