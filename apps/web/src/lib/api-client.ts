import { rawRequest, ApiError, API_BASE_URL } from './raw-request';
import { useAuthStore } from '../stores/auth-store';

export { ApiError, API_BASE_URL };

/**
 * The higher-level counterpart to raw-request.ts - attaches the current
 * access token, and on a 401, attempts exactly one refresh-and-retry
 * before giving up. This is the base every other data-fetching concern
 * in the app builds on (repository list, graph fetch, analysis calls) -
 * none of them need to know a token can expire mid-session or that
 * refreshing it is even a concept; this function is where that's
 * handled, once.
 *
 * Why retry only once, not in a loop?
 *
 * A second 401 after a successful refresh means the NEW token is
 * already invalid too - something is structurally wrong (server clock
 * skew, a revoked session), not a transient timing issue a second retry
 * would fix. Looping here risks a silent infinite retry against a
 * request that can never succeed; failing loudly after one attempt is
 * the safer, more honest behavior.
 */
export async function apiRequest<T>(path: string, options: RequestInit = {}, isRetry = false): Promise<T> {
  const { accessToken } = useAuthStore.getState();

  const headers = new Headers(options.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  try {
    return await rawRequest<T>(path, { ...options, headers });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !isRetry) {
      const refreshed = await useAuthStore.getState().refresh();
      if (refreshed) {
        return apiRequest<T>(path, options, true);
      }
    }
    throw err;
  }
}
