import { describe, it, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import {
  buildDownloadUri,
  normalizeAuthorization,
  inferSuffix,
  detectOssError,
  downloadToFile,
} from '../oss-download.js';

describe('buildDownloadUri', () => {
  it('joins baseUrl and fileId', () => {
    expect(buildDownloadUri('abc123', 'https://oss.example.com/files')).toBe(
      'https://oss.example.com/files/abc123',
    );
  });

  it('trims trailing slashes on baseUrl', () => {
    expect(buildDownloadUri('abc', 'https://oss.example.com/files///')).toBe(
      'https://oss.example.com/files/abc',
    );
  });

  it('url-encodes the fileId segment', () => {
    expect(buildDownloadUri('a b/c', 'https://x')).toBe('https://x/a%20b%2Fc');
  });

  it('throws when fileId is empty', () => {
    expect(() => buildDownloadUri('  ', 'https://x')).toThrow('文件ID不能为空');
  });

  it('throws when baseUrl is empty', () => {
    expect(() => buildDownloadUri('abc', '')).toThrow('未配置OSS下载地址');
  });
});

describe('normalizeAuthorization', () => {
  it('adds the Bearer prefix when missing', () => {
    expect(normalizeAuthorization('token123')).toBe('Bearer token123');
  });

  it('keeps an existing prefix (case-insensitive)', () => {
    expect(normalizeAuthorization('bearer token123')).toBe('bearer token123');
    expect(normalizeAuthorization('Bearer token123')).toBe('Bearer token123');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeAuthorization('  token  ')).toBe('Bearer token');
  });

  it('throws when empty', () => {
    expect(() => normalizeAuthorization('   ')).toThrow('Authorization 不能为空');
  });
});

describe('inferSuffix', () => {
  it('honours an explicit override', () => {
    expect(inferSuffix('x', 'application/pdf', 'png')).toBe('.png');
    expect(inferSuffix('x', null, '.jpg')).toBe('.jpg');
  });

  it('maps known content types', () => {
    expect(inferSuffix('x', 'application/pdf; charset=binary', undefined)).toBe('.pdf');
    expect(inferSuffix('x', 'image/png', undefined)).toBe('.png');
    expect(inferSuffix('x', 'image/jpeg', undefined)).toBe('.jpg');
  });

  it('falls back to the fileId extension, then .bin', () => {
    expect(inferSuffix('report.PDF', null, undefined)).toBe('.pdf');
    expect(inferSuffix('photo.jpeg', null, undefined)).toBe('.jpg');
    expect(inferSuffix('blob', null, undefined)).toBe('.bin');
  });

  it('maps office/document content types', () => {
    expect(
      inferSuffix(
        'x',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        undefined,
      ),
    ).toBe('.docx');
    expect(inferSuffix('x', 'application/msword', undefined)).toBe('.doc');
  });

  it('preserves a document extension when Content-Type is generic octet-stream', () => {
    expect(inferSuffix('立项文件2.docx', 'application/octet-stream', undefined)).toBe('.docx');
    expect(inferSuffix('sheet.xlsx', 'application/octet-stream', undefined)).toBe('.xlsx');
  });
});

describe('detectOssError', () => {
  it('recognizes the OSS Spring error envelope', () => {
    const envelope = Buffer.from(
      JSON.stringify({
        timestamp: '2026-06-16T04:37:39.340+00:00',
        path: '/rest/strg/file/download/oss-x.docx',
        status: 500,
        error: 'Internal Server Error',
        requestId: 'd77afc53-698999',
      }),
    );
    expect(detectOssError(envelope)).toEqual({
      status: 500,
      error: 'Internal Server Error',
      requestId: 'd77afc53-698999',
    });
  });

  it('ignores a legitimate small JSON file (no error markers / non-error status)', () => {
    expect(detectOssError(Buffer.from(JSON.stringify({ name: 'config', status: 'active' })))).toBeNull();
    expect(detectOssError(Buffer.from(JSON.stringify({ status: 200, ok: true, path: '/p' })))).toBeNull();
  });

  it('ignores binary content (e.g. a real docx ZIP)', () => {
    expect(detectOssError(Buffer.from('PKbinary-zip-bytes'))).toBeNull();
  });
});

describe('downloadToFile', () => {
  it('writes the fetched bytes to a temp file and reports metadata', async () => {
    const body = Buffer.from('%PDF-1.4 fake');
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://oss.example.com/f/file-1');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as unknown as typeof fetch;

    const res = await downloadToFile({
      fileId: 'file-1',
      baseUrl: 'https://oss.example.com/f',
      authorization: 'tok',
      fetchImpl,
    });

    expect(res.contentType).toBe('application/pdf');
    expect(res.bytes).toBe(body.length);
    expect(res.path.endsWith('.pdf')).toBe(true);
    try {
      expect(await readFile(res.path)).toEqual(body);
    } finally {
      await rm(res.path, { force: true });
    }
  });

  it('derives the suffix from fileName when Content-Type is absent', async () => {
    const fetchImpl = (async () =>
      new Response(Buffer.from('img'), { status: 200 })) as unknown as typeof fetch;

    const res = await downloadToFile({
      fileId: 'opaque-id-no-ext',
      fileName: '论证报告.png',
      baseUrl: 'https://x',
      authorization: 'tok',
      fetchImpl,
    });
    try {
      expect(res.path.endsWith('.png')).toBe(true);
    } finally {
      await rm(res.path, { force: true });
    }
  });

  it('throws with the status code on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch;

    await expect(
      downloadToFile({
        fileId: 'missing',
        baseUrl: 'https://x',
        authorization: 'tok',
        fetchImpl,
      }),
    ).rejects.toThrow('HTTP 404');
  });

  it('throws when OSS returns HTTP 200 with an error envelope (saves no file)', async () => {
    const envelope = JSON.stringify({
      timestamp: 't',
      path: '/p',
      status: 500,
      error: 'Internal Server Error',
      requestId: 'r1',
    });
    const fetchImpl = (async () =>
      new Response(envelope, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as unknown as typeof fetch;

    await expect(
      downloadToFile({ fileId: 'f', baseUrl: 'https://x', authorization: 'tok', fetchImpl }),
    ).rejects.toThrow('返回错误信息而非文件');
  });
});
