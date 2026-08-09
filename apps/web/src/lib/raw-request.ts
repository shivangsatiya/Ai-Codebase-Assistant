const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Deliberately separate from the higher-level, token-attaching request
 * helper (api-client.ts). Register/login/refresh are the three calls
 * that must never depend on an existing access token - refresh's whole
 * job is producing a NEW token pair when one has expired, so if it
 * routed through the same wrapper that attaches the (expired) token and
 * retries on 401, that would be a genuine circular dependency: the auth
 * store calling a function that calls back into the auth store. This
 * function has no knowledge of auth state at all, on purpose.
 */
export async function rawRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'UNKNOWN_ERROR',
      body?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export { API_BASE_URL };
