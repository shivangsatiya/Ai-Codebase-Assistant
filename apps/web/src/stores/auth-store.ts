import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { rawRequest, ApiError } from '../lib/raw-request';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

interface AuthResponse extends AuthTokens {
  userId: string;
  email: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  email: string | null;
  isAuthenticated: boolean;
  error: string | null;
  isLoading: boolean;

  register: (email: string, password: string) => Promise<boolean>;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  refresh: () => Promise<boolean>;
  clearError: () => void;
}

/**
 * Why does refresh() call rawRequest directly, storing a NEW
 * refreshToken every time, rather than reusing the one already in
 * state?
 *
 * The backend's refresh endpoint rotates the refresh token on every use
 * - the one just spent is immediately invalidated, and a fresh one comes
 * back in the same response. Storing anything other than exactly what
 * the response returns would silently break the next refresh attempt,
 * since the old token this store might otherwise keep around is already
 * dead server-side the moment this call succeeds.
 *
 * Why does refresh() return a boolean rather than throw?
 *
 * A caller (the API client's 401-retry logic) needs to distinguish
 * "refresh succeeded, retry the original request" from "refresh failed,
 * give up and treat the session as ended" without needing its own
 * try/catch around every call site - a plain boolean is the simplest
 * contract for that specific decision.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      userId: null,
      email: null,
      isAuthenticated: false,
      error: null,
      isLoading: false,

      register: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const result = await rawRequest<AuthResponse>('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          set({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            userId: result.userId,
            email: result.email,
            isAuthenticated: true,
            isLoading: false,
          });
          return true;
        } catch (err) {
          set({ error: errorMessage(err), isLoading: false });
          return false;
        }
      },

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const result = await rawRequest<AuthResponse>('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          });
          set({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            userId: result.userId,
            email: result.email,
            isAuthenticated: true,
            isLoading: false,
          });
          return true;
        } catch (err) {
          set({ error: errorMessage(err), isLoading: false });
          return false;
        }
      },

      logout: () => {
        const currentRefreshToken = get().refreshToken;
        // Fire-and-forget - the local session ends regardless of
        // whether this call succeeds; there's no meaningful recovery
        // action for the user if server-side invalidation fails, and
        // waiting on it would only make logout feel slow.
        if (currentRefreshToken) {
          rawRequest('/api/auth/logout', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: currentRefreshToken }),
          }).catch(() => undefined);
        }
        set({
          accessToken: null,
          refreshToken: null,
          userId: null,
          email: null,
          isAuthenticated: false,
          error: null,
        });
      },

      refresh: async () => {
        const currentRefreshToken = get().refreshToken;
        if (!currentRefreshToken) return false;

        try {
          const result = await rawRequest<AuthResponse>('/api/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refreshToken: currentRefreshToken }),
          });
          set({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            userId: result.userId,
            email: result.email,
            isAuthenticated: true,
          });
          return true;
        } catch {
          // Refresh reuse-detection (Milestone 1.5) means a failed
          // refresh could mean the token was already used - the only
          // safe response is to treat the whole session as ended, not
          // retry or guess.
          set({
            accessToken: null,
            refreshToken: null,
            userId: null,
            email: null,
            isAuthenticated: false,
          });
          return false;
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'ai-codebase-assistant-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        userId: state.userId,
        email: state.email,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}
