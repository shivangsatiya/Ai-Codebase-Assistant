import { InferredAnnotationExtractor } from '../src/services/knowledge-graph/inferred-annotation-extractor';
import type { ExtractorFileInput } from '../src/services/knowledge-graph/deterministic-extractor';
import type { IChatCompletionProvider, StreamCompletionParams } from '../src/clients/chat-completion-provider';
import { logger } from '../src/utils/logger';

class FakeChatCompletionProvider implements IChatCompletionProvider {
  public callCount = 0;
  public lastParams: StreamCompletionParams | null = null;

  constructor(private readonly responses: string[]) {}

  async *streamCompletion(params: StreamCompletionParams): AsyncIterable<string> {
    this.lastParams = params;
    const response = this.responses[this.callCount] ?? this.responses[this.responses.length - 1] ?? '';
    this.callCount++;
    // Yield character by character - a real streaming provider yields
    // in small pieces, not the whole response as one token, so parsing
    // must correctly accumulate before attempting JSON.parse.
    for (const char of response) {
      yield char;
    }
  }
}

function file(relativePath: string, content = ''): ExtractorFileInput {
  return { relativePath, content, extension: '.ts' };
}

/**
 * Simulates the real, typed shape groq-sdk's own RateLimitError has -
 * confirmed directly against node_modules/groq-sdk/core/error.d.ts
 * (`class RateLimitError extends APIError<429, Headers>`) rather than
 * assumed. A plain object with a `status` field is sufficient here
 * since the real detection logic only checks `err.status === 429`, not
 * the specific error class.
 */
class QuotaExhaustedProvider implements IChatCompletionProvider {
  async *streamCompletion(): AsyncIterable<string> {
    const err = new Error('Rate limit reached') as Error & { status: number };
    err.status = 429;
    throw err;
  }
}

class GenericFailureProvider implements IChatCompletionProvider {
  async *streamCompletion(): AsyncIterable<string> {
    throw new Error('Simulated generic provider failure');
  }
}

describe('InferredAnnotationExtractor - successful classification', () => {
  it('produces a service node and a defines edge for a file classified as a service', async () => {
    const response = JSON.stringify({
      isRoute: false,
      httpMethod: null,
      httpPath: null,
      isService: true,
      isController: false,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: 'AuthService',
    });
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider([response]));

    const { nodes, edges } = await extractor.extract([file('src/auth.ts')]);

    const serviceNode = nodes.find((n) => n.type === 'service');
    expect(serviceNode).toBeDefined();
    expect(serviceNode!.label).toBe('AuthService');
    expect(serviceNode!.certainty).toBe('inferred');
    expect(edges.find((e) => e.type === 'defines' && e.targetType === 'service')).toBeDefined();
  });

  it('produces a route node with the correct (httpMethod, httpPath) identity, matching the existing route builder', async () => {
    const response = JSON.stringify({
      isRoute: true,
      httpMethod: 'get',
      httpPath: '/api/users',
      isService: false,
      isController: false,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: null,
    });
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider([response]));

    const { nodes } = await extractor.extract([file('src/routes/users.ts')]);

    const routeNode = nodes.find((n) => n.type === 'route');
    expect(routeNode).toBeDefined();
    expect(routeNode!.idComponents).toEqual(['get', '/api/users']);
  });

  it('does not create a route node when isRoute is true but method/path are unknown - honest, not a guess', async () => {
    const response = JSON.stringify({
      isRoute: true,
      httpMethod: null,
      httpPath: null,
      isService: false,
      isController: false,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: null,
    });
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider([response]));

    const { nodes } = await extractor.extract([file('src/routes/unclear.ts')]);

    expect(nodes.find((n) => n.type === 'route')).toBeUndefined();
  });

  it('produces multiple node types for a single file when multiple flags are true', async () => {
    const response = JSON.stringify({
      isRoute: false,
      httpMethod: null,
      httpPath: null,
      isService: true,
      isController: true,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: 'UserController',
    });
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider([response]));

    const { nodes } = await extractor.extract([file('src/user.ts')]);

    expect(nodes.find((n) => n.type === 'service')).toBeDefined();
    expect(nodes.find((n) => n.type === 'controller')).toBeDefined();
  });

  it('classifies multiple files independently, one LLM call per file', async () => {
    const serviceResponse = JSON.stringify({
      isRoute: false,
      httpMethod: null,
      httpPath: null,
      isService: true,
      isController: false,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: 'A',
    });
    const dbModelResponse = JSON.stringify({
      isRoute: false,
      httpMethod: null,
      httpPath: null,
      isService: false,
      isController: false,
      isDbModel: true,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: 'B',
    });
    const provider = new FakeChatCompletionProvider([serviceResponse, dbModelResponse]);
    const extractor = new InferredAnnotationExtractor(provider);

    const { nodes } = await extractor.extract([file('src/a.ts'), file('src/b.ts')]);

    expect(provider.callCount).toBe(2);
    expect(nodes.find((n) => n.type === 'service')).toBeDefined();
    expect(nodes.find((n) => n.type === 'dbModel')).toBeDefined();
  });
});

describe('InferredAnnotationExtractor - graceful degradation', () => {
  it('skips a file entirely, without throwing, when the LLM returns malformed JSON', async () => {
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider(['not valid json at all']));

    const { nodes, edges } = await extractor.extract([file('src/weird.ts')]);

    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('strips markdown code fences before parsing, if the LLM adds them despite being told not to', async () => {
    const response =
      '```json\n' +
      JSON.stringify({
        isRoute: false,
        httpMethod: null,
        httpPath: null,
        isService: true,
        isController: false,
        isDbModel: false,
        isCache: false,
        isQueue: false,
        isEvent: false,
        isConfiguration: false,
        isAuthComponent: false,
        entityName: 'Fenced',
      }) +
      '\n```';
    const extractor = new InferredAnnotationExtractor(new FakeChatCompletionProvider([response]));

    const { nodes } = await extractor.extract([file('src/fenced.ts')]);

    expect(nodes.find((n) => n.type === 'service' && n.label === 'Fenced')).toBeDefined();
  });

  it('skips a file when the response is missing required fields, rather than guessing defaults', async () => {
    const extractor = new InferredAnnotationExtractor(
      new FakeChatCompletionProvider([JSON.stringify({ isService: true })]),
    );

    const { nodes } = await extractor.extract([file('src/incomplete.ts')]);

    expect(nodes).toEqual([]);
  });

  it('a failure on one file does not prevent other files from being classified successfully', async () => {
    const goodResponse = JSON.stringify({
      isRoute: false,
      httpMethod: null,
      httpPath: null,
      isService: true,
      isController: false,
      isDbModel: false,
      isCache: false,
      isQueue: false,
      isEvent: false,
      isConfiguration: false,
      isAuthComponent: false,
      entityName: 'Good',
    });
    const provider = new FakeChatCompletionProvider(['garbage', goodResponse]);
    const extractor = new InferredAnnotationExtractor(provider);

    const { nodes } = await extractor.extract([file('src/bad.ts'), file('src/good.ts')]);

    expect(nodes.find((n) => n.label === 'Good')).toBeDefined();
  });
});

describe('InferredAnnotationExtractor - quota-exhaustion classification (Milestone 4 Task 5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('classifies a real, typed 429 as quota exhaustion, not a generic failure, in the summary log', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const extractor = new InferredAnnotationExtractor(new QuotaExhaustedProvider());

    await extractor.extract([file('src/a.ts'), file('src/b.ts'), file('src/c.ts')]);

    const summaryLog = infoSpy.mock.calls.find((c) => c[1] === 'Inferred (LLM) extraction coverage summary');
    expect(summaryLog).toBeDefined();
    const payload = summaryLog![0] as Record<string, unknown>;
    expect(payload.attemptedCount).toBe(3);
    expect(payload.succeededCount).toBe(0);
    expect(payload.quotaExhaustedCount).toBe(3);
    expect(payload.otherFailureCount).toBe(0);
    expect(payload.inferredCoveragePercent).toBe(0);
    expect(payload.firstQuotaExhaustedAtFile).toBe('src/a.ts');
  });

  it('classifies a generic (non-429) failure as "other", not quota exhaustion', async () => {
    const infoSpy = jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const extractor = new InferredAnnotationExtractor(new GenericFailureProvider());

    await extractor.extract([file('src/a.ts')]);

    const summaryLog = infoSpy.mock.calls.find((c) => c[1] === 'Inferred (LLM) extraction coverage summary');
    const payload = summaryLog![0] as Record<string, unknown>;
    expect(payload.quotaExhaustedCount).toBe(0);
    expect(payload.otherFailureCount).toBe(1);
  });

  it(
    'REGRESSION: a real, mixed run (some files succeed, then quota exhausts partway through) reports an ' +
      'honest, real coverage percentage - never claims full inferred coverage when it was actually partial',
    async () => {
      const infoSpy = jest.spyOn(logger, 'info');
      jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      let callCount = 0;
      class MixedProvider implements IChatCompletionProvider {
        async *streamCompletion(_params: StreamCompletionParams): AsyncIterable<string> {
          callCount++;
          if (callCount <= 2) {
            const response = JSON.stringify({
              isRoute: false,
              httpMethod: null,
              httpPath: null,
              isService: true,
              isController: false,
              isDbModel: false,
              isCache: false,
              isQueue: false,
              isEvent: false,
              isConfiguration: false,
              isAuthComponent: false,
              entityName: null,
            });
            for (const char of response) yield char;
          } else {
            const err = new Error('Rate limit reached') as Error & { status: number };
            err.status = 429;
            throw err;
          }
        }
      }
      const extractor = new InferredAnnotationExtractor(new MixedProvider());

      await extractor.extract([file('src/a.ts'), file('src/b.ts'), file('src/c.ts'), file('src/d.ts')]);

      const summaryLog = infoSpy.mock.calls.find((c) => c[1] === 'Inferred (LLM) extraction coverage summary');
      const payload = summaryLog![0] as Record<string, unknown>;
      expect(payload.attemptedCount).toBe(4);
      expect(payload.succeededCount).toBe(2);
      expect(payload.quotaExhaustedCount).toBe(2);
      expect(payload.inferredCoveragePercent).toBe(50);
      expect(payload.firstQuotaExhaustedAtFile).toBe('src/c.ts');
    },
  );
});
