/**
 * OSS 下载的无状态辅助逻辑，移植自 scene-ai 的
 * `cn.fanzai.scenecommon.common.utils.OssUtils`：
 *   - {@link buildDownloadUri} 拼装 `baseUrl/fileId` 下载地址。
 *   - {@link normalizeAuthorization} 标准化 `Authorization`，确保 `Bearer ` 前缀。
 * 纯函数，不持有配置、不发请求；网络下载由 {@link downloadToFile} 负责。
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

const BEARER_PREFIX = 'Bearer ';

/** 去掉字符串末尾的所有 `/`，与 Java 端 `trimTrailingSlash` 等价。 */
function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end--;
  return value.slice(0, end);
}

/**
 * 拼装 OSS 文件下载地址 `baseUrl/fileId`。`fileId` 作为单独的 path segment 编码，
 * 与 Java `UriComponentsBuilder.pathSegment` 行为一致。
 * @throws Error fileId 为空或 baseUrl 未配置时抛出。
 */
export function buildDownloadUri(fileId: string, baseUrl: string): string {
  const id = (fileId ?? '').trim();
  const base = (baseUrl ?? '').trim();
  if (id === '') throw new Error('文件ID不能为空');
  if (base === '') throw new Error('未配置OSS下载地址');
  return `${trimTrailingSlash(base)}/${encodeURIComponent(id)}`;
}

/**
 * 标准化 Authorization 头，确保以 `Bearer ` 开头（已带前缀则原样返回，忽略大小写）。
 * @throws Error authorization 为空时抛出。
 */
export function normalizeAuthorization(authorization: string): string {
  if (authorization == null || authorization.trim() === '') {
    throw new Error('Authorization 不能为空');
  }
  const normalized = authorization.trim();
  const hasPrefix = normalized.slice(0, BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX.toLowerCase();
  return hasPrefix ? normalized : BEARER_PREFIX + normalized;
}

/** 由 Content-Type / 文件名后缀推断本地落盘文件的扩展名（含 `.`）。 */
export function inferSuffix(nameOrId: string, contentType: string | null, override?: string): string {
  if (override && override.trim() !== '') {
    const o = override.trim();
    return o.startsWith('.') ? o : `.${o}`;
  }
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const byType: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/tiff': '.tiff',
    'image/bmp': '.bmp',
    'image/webp': '.webp',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/html': '.html',
    'text/markdown': '.md',
    'application/rtf': '.rtf',
  };
  if (byType[ct]) return byType[ct];
  // OSS commonly serves application/octet-stream, so the filename extension is the
  // only reliable signal. Preserve any extension the downstream extractor (Kreuzberg)
  // or Read can handle — notably DOCX/XLSX/PPTX, the reason Kreuzberg exists. Forcing
  // unknown types to .bin makes extract_file fail to detect the real format.
  const ext = extname(nameOrId).toLowerCase();
  const known =
    /^\.(pdf|jpe?g|png|tiff?|bmp|webp|gif|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|tsv|html?|md|markdown|xml|json)$/;
  if (known.test(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  return '.bin';
}

export interface DownloadOptions {
  fileId: string;
  baseUrl: string;
  authorization: string;
  /** 原始文件名（如 `论证报告.pdf`），用于推断落盘扩展名；可选。 */
  fileName?: string;
  /** 覆盖落盘扩展名（如 `pdf`/`.png`）；缺省时由 Content-Type / 文件名推断。 */
  suffix?: string;
  /**
   * 落盘目录；缺省系统临时目录。设为与 Kreuzberg 容器共享、且容器内同路径的目录，
   * 返回的 path 才能被 `extract_file` 在容器内直接读取。
   */
  dir?: string;
  /** 注入用于测试；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  /** 下载文件的本地绝对路径，供 agent 用 Read 读取。 */
  path: string;
  contentType: string | null;
  bytes: number;
}

interface OssErrorEnvelope {
  status: number;
  error?: string;
  requestId?: string;
}

/**
 * 识别 OSS 失败时返回的 Spring Boot 错误 JSON（HTTP 仍是 200，body 是
 * `{timestamp,path,status,error,requestId}` 而非文件字节）。命中则返回错误信息，
 * 否则返回 null。判定从严（需 status≥400 + error/message + timestamp/path 标记），
 * 避免把合法的小 `.json` 文件误判为错误页。
 */
export function detectOssError(buf: Buffer): OssErrorEnvelope | null {
  const text = buf.toString('utf8').trim();
  if (!text.startsWith('{') || text.length > 4096) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const status = typeof o.status === 'number' ? o.status : NaN;
  const hasErrMsg = typeof o.error === 'string' || typeof o.message === 'string';
  if (!(status >= 400 && hasErrMsg && ('timestamp' in o || 'path' in o))) return null;
  return {
    status,
    error: typeof o.error === 'string' ? o.error : undefined,
    requestId: typeof o.requestId === 'string' ? o.requestId : undefined,
  };
}

/**
 * 通过 OSS 下载文件并写入系统临时目录，返回本地路径。
 * @throws Error 参数非法、HTTP 非 2xx、或 OSS 返回错误信封（HTTP 200 但 body 是
 *   错误 JSON）时抛出——后者避免把错误页当成文件落盘、进而产出错误的核查结论。
 */
export async function downloadToFile(opts: DownloadOptions): Promise<DownloadResult> {
  const uri = buildDownloadUri(opts.fileId, opts.baseUrl);
  const authorization = normalizeAuthorization(opts.authorization);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(uri, { headers: { Authorization: authorization } });
  if (!res.ok) {
    throw new Error(`OSS 下载失败：HTTP ${res.status} ${res.statusText} (${uri})`);
  }

  const contentType = res.headers.get('content-type');
  const buf = Buffer.from(await res.arrayBuffer());

  // OSS returns HTTP 200 even on failure, with a tiny JSON error envelope instead
  // of the file. Fail loudly here so the error page is never saved as a "file" and
  // mistaken downstream for an empty/corrupt report (which yields a false verdict).
  const err = detectOssError(buf);
  if (err) {
    throw new Error(
      `OSS 下载失败：返回错误信息而非文件（status=${err.status}` +
        `${err.error ? ` ${err.error}` : ''}${err.requestId ? `, requestId=${err.requestId}` : ''}` +
        `, ${uri}）`,
    );
  }

  const suffix = inferSuffix(opts.fileName ?? opts.fileId, contentType, opts.suffix);
  const dir = opts.dir && opts.dir.trim() !== '' ? opts.dir : tmpdir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `oss-${randomUUID()}${suffix}`);
  await writeFile(path, buf);

  return { path, contentType, bytes: buf.length };
}
