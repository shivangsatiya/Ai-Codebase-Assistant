import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiRequest } from '../api-client';
import { useAuthStore } from '../../stores/auth-store';

function resetStore(): void {
  useAuthStore.setState({
    accessToken: 'valid-access',
    refreshToken: 'refresh-1',
    userId: 'user-1',
    email: 'test@example.com',
    isAuthenticated: true,
    error: null,
    isLoading: false,
  });
}

describe('apiRequest - the 401-retry-once orchestration', () => {
  beforeEach(() => {
    resetStore();
  });

  it('attaches the current access token as a Bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: 'ok' }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiRequest('/api/repositories');

    const [, options] = fetchMock.mock.calls[0]!;
    expect((options as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((options as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer valid-access');
  });

  it('on a 401, refreshes once and retries the original request with the new token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          userId: 'user-1',
          email: 'test@example.com',
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: 'ok' }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await apiRequest<{ data: string }>('/api/repositories');

    expect(result).toEqual({ data: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [, retryOptions] = fetchMock.mock.calls[2]!;
    expect(((retryOptions as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer new-access');
  });

  it('fails loudly after one retry, rather than looping, if the token is STILL invalid after refresh', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          userId: 'user-1',
          email: 'test@example.com',
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiRequest('/api/repositories')).rejects.toThrow('Invalid or expired token');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up immediately, without retrying, when refresh itself fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } }),
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiRequest('/api/repositories')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('does not attempt a refresh at all for a non-401 error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'Not found' } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiRequest('/api/repositories/nonexistent')).rejects.toThrow('Not found');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
