import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

export interface SkillParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  /** "file" = this param carries file references that the request adapter should resolve to local paths. */
  resolve?: string;
}

export interface SkillConfig {
  name: string;
  description: string;
  params: {
    required: SkillParam[];
    optional: SkillParam[];
  };
  output: Record<string, unknown>;
  /** Per-skill MCP servers from the skill's sidecar `.mcp.json` (if present). */
  mcpServers?: Record<string, McpServerConfig>;
}

export type SkillRequest = Record<string, unknown>;

export interface UploadedFileMeta {
  /** Form field name (multipart) or skill param name (OSS). */
  fieldname: string;
  /** Original filename (multipart) or fileName / fileId (OSS). */
  originalname: string;
  /** Absolute local path to the saved file. */
  path: string;
  /** File size in bytes (0 if unknown). */
  size: number;
  /** Where the file came from. */
  source: 'upload' | 'oss';
  /** OSS fileId, only present when source === 'oss'. */
  fileId?: string;
}

export interface QueryResponse {
  success: boolean;
  data?: unknown;
  cost?: number;
  turns?: number;
  error?: string;
  /** Diagnostic context on failure (final model text, denied tools, etc.). */
  detail?: string;
}
