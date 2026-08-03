// Runs via Jest's `setupFiles`, which executes before the test framework
// and before any test file's own imports — so config/env.ts sees valid
// values the first time it's imported, instead of exiting the process
// because JWT_SECRET/MONGODB_URI are missing.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-at-least-32-characters-long';
process.env.MONGODB_URI = 'mongodb://placeholder:27017/test'; // overwritten by setup.ts before use
process.env.BCRYPT_SALT_ROUNDS = '10'; // schema enforces min 10; unit tests bypass this via direct constructor args for speed
// No embedding provider env vars needed - LocalEmbeddingClient requires
// no API key. Tests that exercise it inject a fake extractor directly
// rather than relying on env-driven configuration at all.
process.env.GROQ_API_KEY = 'test-only-fake-groq-key';
process.env.GROQ_MODEL = 'llama-3.3-70b-versatile';
process.env.GROQ_MAX_TOKENS = '1024';
process.env.CHAT_RETRIEVAL_TOP_K = '8';
process.env.ALLOWED_ORIGINS = 'http://allowed-origin.test';
// Deliberately generous in tests - the real, low production limits would
// break integration tests that legitimately make several sequential
// requests to the same endpoint (e.g. auth.routes.test.ts registering
// multiple users across its test cases). The limiting BEHAVIOR itself is
// tested separately, in isolation, by tests/rate-limit.test.ts.
process.env.RATE_LIMIT_AUTH_MAX = '10000';
process.env.RATE_LIMIT_IMPORT_MAX = '10000';
process.env.RATE_LIMIT_CHAT_MAX = '10000';
process.env.MAX_REPO_FILES = '3000';
process.env.MAX_FILE_SIZE_KB = '500';
