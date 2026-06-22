/**
 * Core normalization layer: unwrap the incoming HTTP request (multipart or JSON)
 * into a flat `NormalizedRequest` with all file references resolved to local paths.
 *
 * - multipart/form-data  →  multer DiskStorage, files saved under FILES_DIR
 * - application/json     →  express.json() + OSS download for resolve='file' params
 */
import type { Request } from 'express';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { FILES_DIR, MAX_FILE_SIZE, OSS_BASE_URL } from './config.js';
import { downloadToFile } from './oss-download.js';
import type { DownloadResult } from './oss-download.js';
import { createLogger } from './logger.js';
import type { SkillConfig, SkillParam, SkillRequest, UploadedFileMeta } from './types.js';

const log = createLogger('request-adapter');

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** The normalized, fully-resolved request ready to be passed to the agent. */
export interface NormalizedRequest {
  /** Skill params with all file references resolved to local paths. */
  params: SkillRequest;
  /** Metadata for every file that was uploaded or downloaded. */
  files: UploadedFileMeta[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a human-readable size string ("10mb", "256kb") into bytes. */
function parseBytes(value: string): number {
  const match = value.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) throw new Error(`Cannot parse size string: ${value}`);
  const num = parseFloat(match[1]);
  const unit = match[2] ?? 'b';
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(num * multipliers[unit]);
}

/** All params (required + optional) for a skill, flattened. */
function getAllParams(skill: SkillConfig): SkillParam[] {
  return [...skill.params.required, ...skill.params.optional];
}

/**
 * Detect whether `value` is an array of OSS file-descriptor objects:
 *   `[{ "id": "xxx", "name": "report.pdf", ... }]`
 *
 * Every element must be a plain object with a non-empty string `id`.
 */
function isFileIdArray(
  value: unknown,
): value is Array<{ id: string; name?: string; suffix?: string; [extra: string]: unknown }> {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      'id' in item &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      (item as Record<string, unknown>).id !== '',
  );
}

// ---------------------------------------------------------------------------
// Multer
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.diskStorage({
    destination: FILES_DIR,
    filename: (_req, file, cb) => {
      cb(null, `multer-${randomUUID()}${extname(file.originalname)}`);
    },
  }),
  limits: {
    fileSize: parseBytes(MAX_FILE_SIZE),
    files: 20,
    parts: 50,
    // Multer does not have a single 'total upload size' limit — the closest
    // is `fieldSize` (per text field).  Multipart relies on the per‑file
    // limit above plus the OS TCP buffer.
  },
});

// ---------------------------------------------------------------------------
// Normalize — multipart
// ---------------------------------------------------------------------------

async function normalizeMultipart(
  req: Request,
  skill: SkillConfig,
): Promise<NormalizedRequest> {
  log.debug('normalizeMultipart start', { skill: skill.name });

  // Parse the multipart body via multer.
  try {
    await new Promise<void>((resolve, reject) => {
      upload.any()(req, {} as express.Response, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    log.warn('Multer parse error', { skill: skill.name, error: String(err) });
    throw err;
  }

  const params: SkillRequest = { ...(req.body as Record<string, unknown>) };
  const files: UploadedFileMeta[] = [];
  const reqFiles = (req as unknown as { files?: Express.Multer.File[] }).files ?? [];

  // Collect metadata for every uploaded file.
  for (const f of reqFiles) {
    files.push({
      fieldname: f.fieldname,
      originalname: f.originalname,
      path: f.path,
      size: f.size,
      source: 'upload',
    });
  }

  // For each `resolve='file'` param, inject the matching uploaded file paths.
  const resolveFileParams = getAllParams(skill).filter((p) => p.resolve === 'file');
  for (const param of resolveFileParams) {
    const matched = reqFiles.filter((f) => f.fieldname === param.name);
    if (matched.length === 0) continue;
    if (param.type === 'array') {
      params[param.name] = matched.map((f) => ({ path: f.path, name: f.originalname, size: f.size }));
    } else {
      // Single file param — take the first match.
      params[param.name] = matched[0].path;
    }
  }

  return { params, files };
}

// ---------------------------------------------------------------------------
// Normalize — JSON
// ---------------------------------------------------------------------------

async function normalizeJson(
  req: Request,
  skill: SkillConfig,
  authorization?: string,
): Promise<NormalizedRequest> {
  log.debug('normalizeJson start', { skill: skill.name });

  const params: SkillRequest = { ...(req.body as SkillRequest) };
  const files: UploadedFileMeta[] = [];
  const resolveFileParams = getAllParams(skill).filter((p) => p.resolve === 'file');

  for (const param of resolveFileParams) {
    const value = params[param.name];
    if (value === undefined || value === null) continue;

    if (isFileIdArray(value)) {
      const resolved: Record<string, unknown>[] = [];
      for (const fi of value) {
        const auth = authorization ?? '';
        if (!auth) {
          throw new Error(
            `Skill "${skill.name}" param "${param.name}" requires OSS file download ` +
            `but no Authorization header was provided`,
          );
        }
        if (!OSS_BASE_URL) {
          throw new Error(
            `Skill "${skill.name}" param "${param.name}" requires OSS file download ` +
            `but OSS_BASE_URL is not configured`,
          );
        }
        let result: DownloadResult;
        try {
          result = await downloadToFile({
            fileId: fi.id,
            baseUrl: OSS_BASE_URL,
            authorization: auth,
            fileName: fi.name,
            suffix: fi.suffix,
            dir: FILES_DIR,
          });
        } catch (err) {
          log.warn('OSS download failed', { fileId: fi.id, skill: skill.name, error: String(err) });
          throw err;
        }
        log.info('OSS file downloaded', { fileId: fi.id, bytes: result.bytes, path: result.path });
        files.push({
          fieldname: param.name,
          originalname: fi.name ?? fi.id,
          path: result.path,
          size: result.bytes,
          source: 'oss',
          fileId: fi.id,
        });
        resolved.push({
          ...fi,
          path: result.path,
        });
      }
      params[param.name] = resolved;
    }
    // If the value is not a file-id array (e.g. already a list of local paths),
    // leave it as-is — the caller already provided resolved paths.
  }

  return { params, files };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Normalize an incoming Express request into a flat `NormalizedRequest`.
 *
 * - **multipart/form-data**: files are saved to FILES_DIR via multer; file paths
 *   are injected into `resolve='file'` params.
 * - **application/json** (default): the body is parsed with express.json(). For
 *   each `resolve='file'` param whose value is an array of `{id, name}` objects,
 *   files are downloaded from OSS and replaced with `{...entry, path}` entries.
 *
 * @param req          Incoming Express request.
 * @param skill        The resolved skill configuration.
 * @param authorization Optional Authorization header value for OSS downloads.
 */
export async function normalizeRequest(
  req: Request,
  skill: SkillConfig,
  authorization?: string,
): Promise<NormalizedRequest> {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();

  if (contentType.startsWith('multipart/form-data')) {
    return normalizeMultipart(req, skill);
  }

  return normalizeJson(req, skill, authorization);
}
