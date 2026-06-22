import { describe, it, expect } from 'vitest';
import { httpEnvFromHeaders } from '../http-env.js';

describe('httpEnvFromHeaders', () => {
  it('prefixes HTTP_, uppercases, and turns dashes into underscores', () => {
    expect(
      httpEnvFromHeaders({ authorization: 'Bearer x', 'x-tenant-id': 'acme' }),
    ).toEqual({ HTTP_AUTHORIZATION: 'Bearer x', HTTP_X_TENANT_ID: 'acme' });
  });

  it('joins multi-value headers with ", "', () => {
    expect(httpEnvFromHeaders({ 'set-cookie': ['a=1', 'b=2'] })).toEqual({
      HTTP_SET_COOKIE: 'a=1, b=2',
    });
  });

  it('skips undefined header values', () => {
    expect(httpEnvFromHeaders({ host: 'localhost', 'x-empty': undefined })).toEqual({
      HTTP_HOST: 'localhost',
    });
  });

  it('returns an empty object for no headers', () => {
    expect(httpEnvFromHeaders({})).toEqual({});
  });
});
