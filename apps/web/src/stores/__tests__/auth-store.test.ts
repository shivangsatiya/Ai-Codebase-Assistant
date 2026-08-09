import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from '../auth-store';

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

function resetStore(): void {
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    userId: null,
    email: null,
    isAuthenticated: false,
    error: null,
    isLoading: false,
  });
}

describe('useAuthStore - register', () => {
  beforeEach(() => {
    resetStore();
  });

  it('stores both tokens and marks the user authenticated on success', async () => {
    mockFetchOnce(201, {
      userId: 'user-1',
      email: 'test@example.com',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    const success = await useAuthStore.getState().register('test@example.com', 'Password123');

    expect(success).toBe(true);
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('access-1');
    expect(state.refreshToken).toBe('refresh-1');
    expect(state.isAuthenticated).toBe(true);
  });

  it('sets a clear error and does not authenticate on failure, without throwing', async () => {
    mockFetchOnce(422, { error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' } });

    const success = await useAuthStore.getState().register('test@example.com', 'short');

    expect(success).toBe(false);
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.error).toBe('Password must be at least 8 characters');
  });
});

describe('useAuthStore - login', () => {
  beforeEach(() => {
    resetStore();
  });

  it('authenticates on success', async () => {
    mockFetchOnce(200, {
      userId: 'user-1',
      email: 'test@example.com',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    const success = await useAuthStore.getState().login('test@example.com', 'Password123');

    expect(success).toBe(true);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('sets an error and stays unauthenticated on invalid credentials', async () => {
    mockFetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });

    const success = await useAuthStore.getState().login('test@example.com', 'wrong');

    expect(success).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

describe('useAuthStore - refresh', () => {
  beforeEach(() => {
    resetStore();
    useAuthStore.setState({
      accessToken: 'expired-access',
      refreshToken: 'refresh-1',
      userId: 'user-1',
      email: 'test@example.com',
      isAuthenticated: true,
    });
  });

  it('replaces BOTH tokens with the new pair on success - the real rotation behavior', async () => {
    mockFetchOnce(200, {
      userId: 'user-1',
      email: 'test@example.com',
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
    });

    const success = await useAuthStore.getState().refresh();

    expect(success).toBe(true);
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('access-2');
    expect(state.refreshToken).toBe('refresh-2');
  });

  it('ends the session entirely on a failed refresh, rather than retrying or guessing - reuse detection can burn the whole session', async () => {
    mockFetchOnce(401, { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });

    const success = await useAuthStore.getState().refresh();

    expect(success).toBe(false);
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('returns false immediately, without calling fetch at all, when there is no refresh token to use', async () => {
    resetStore();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const success = await useAuthStore.getState().refresh();

    expect(success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useAuthStore - logout', () => {
  beforeEach(() => {
    resetStore();
    useAuthStore.setState({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      userId: 'user-1',
      email: 'test@example.com',
      isAuthenticated: true,
    });
  });

  it('clears local session state immediately, without waiting for the server call to resolve', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => undefined)) as unknown as typeof fetch;

    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('still clears local state even if the server-side logout call fails outright', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    useAuthStore.getState().logout();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
