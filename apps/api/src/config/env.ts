import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Why validate env vars with Zod instead of just reading process.env directly?
 *
 * Without this: a missing JWT_SECRET doesn't fail until the first login attempt,
 * in production, at 2am, as a 500 error with a confusing stack trace.
 *
 * With this: the process refuses to start at all if config is wrong, with a
 * clear message telling you exactly which variable is missing or malformed.
 * "Fail fast" applied to configuration, not just business logic.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TOKEN_TTL: z.string().default('15m'),
  JWT_REFRESH_TOKEN_TTL: z.string().default('7d'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  // Local embedding model (via @huggingface/transformers) - no API key
  // needed at all. Override only if you want a different ONNX-exported
  // sentence embedding model from the Hugging Face hub.
  LOCAL_EMBEDDING_MODEL: z.string().default('onnx-community/all-MiniLM-L6-v2-ONNX'),
  GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  // Windows are fixed (15 min for auth, 1 hour for import/chat) - only
  // the request counts are configurable, since a window rarely needs
  // per-deployment tuning but the right count depends on real usage
  // patterns you won't know until you have some.
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_IMPORT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_CHAT_MAX: z.coerce.number().int().positive().default(30),
  // Comma-separated list of origins allowed to make cross-origin
  // requests from a browser. Defaults to common local dev frontend
  // ports so local development doesn't regress - a real deployment
  // MUST override this with its actual frontend origin(s), since the
  // default is intentionally permissive only for localhost.
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:5173')
    .transform((val) => val.split(',').map((origin) => origin.trim()).filter(Boolean)),
  // How many chunks to retrieve per question - design doc starts at 8.
  CHAT_RETRIEVAL_TOP_K: z.coerce.number().int().positive().default(8),
  // Not GitHub OAuth (see TOKEN_ENCRYPTION_KEY and GitHubConnection for
  // that, Milestone 2) - just a personal access token used server-side
  // to authenticate calls to the GitHub REST API. Unauthenticated
  // requests are capped at 60/hour *per IP*, shared across everyone
  // behind that IP (a home router, an office network, etc.) - a token
  // raises that to 5000/hour for this server specifically. A token with
  // zero scopes is enough for reading public repo metadata.
  GITHUB_TOKEN: z.string().optional(),
  // Milestone 2: encrypts GitHub OAuth tokens (and any future sensitive
  // secret needing reversible, not one-way, storage) at rest via
  // TokenEncryptor. Base64-encoded 32-byte value for AES-256 - generate
  // with: openssl rand -base64 32 (same pattern as JWT_SECRET). Now
  // required (was optional through Task 1-2) - this task's composition
  // root actually constructs a TokenEncryptor and wires it into the
  // OAuth flow for real, so a missing key now fails startup loudly
  // rather than silently not mattering the way it did before anything
  // consumed it.
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(44, 'TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte value - generate with: openssl rand -base64 32'),
  // Milestone 2: a GitHub OAuth App's credentials (github.com -> Settings
  // -> Developer settings -> OAuth Apps -> New OAuth App). The
  // Authorization callback URL registered on GitHub MUST exactly match
  // GITHUB_OAUTH_REDIRECT_URI below, or GitHub rejects the callback
  // before this app ever sees it.
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1, 'GITHUB_OAUTH_CLIENT_ID is required'),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1, 'GITHUB_OAUTH_CLIENT_SECRET is required'),
  GITHUB_OAUTH_REDIRECT_URI: z.string().url('GITHUB_OAUTH_REDIRECT_URI must be a full URL'),
  // How many GET /api/auth/github requests (starting a connect attempt)
  // a single user can make per hour - a real gap the design review
  // required fixing, since being authenticated doesn't rate-limit
  // anything on its own.
  RATE_LIMIT_GITHUB_OAUTH_MAX: z.coerce.number().int().positive().default(10),
  // Repo-size ceiling (non-functional requirement: reject oversized repos
  // rather than let an import silently run for an hour or exhaust memory).
  MAX_REPO_FILES: z.coerce.number().int().positive().default(3000),
  /**
   * How long a job may sit unchanged in a non-terminal stage (or in a
   * retryable failure) before the sweep considers it eligible for
   * recovery. Default: 10 minutes - a deliberately generous multiple
   * of the worst real, MEASURED stage duration in this project
   * (embedding alone took ~156s for a real 56-file repository,
   * Milestone 4 Task 1's own finding), not a guess. Generous enough to
   * avoid claiming a job that's simply still legitimately working on a
   * larger-than-usual repository.
   */
  STALE_JOB_THRESHOLD_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * How often the sweep checks for stale/retryable jobs at all.
   * Default: 60 seconds - frequent enough that a genuinely stuck job
   * is recovered reasonably soon after crossing the staleness
   * threshold, without hammering the database with a query every few
   * seconds.
   */
  STALE_JOB_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MAX_FILE_SIZE_KB: z.coerce.number().int().positive().default(500),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:');
    // eslint-disable-next-line no-console
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  return parsed.data;
}

export const env = loadEnv();
export type Env = typeof env;
