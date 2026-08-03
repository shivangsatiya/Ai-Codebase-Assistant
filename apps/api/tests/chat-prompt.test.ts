import { buildSystemPrompt, extractCitations } from '../src/services/chat-prompt';
import type { ChunkSearchResult } from '../src/repositories/chunk.repository';

function makeChunk(overrides: Partial<ChunkSearchResult> = {}): ChunkSearchResult {
  return {
    filePath: 'src/auth.ts',
    startLine: 10,
    endLine: 20,
    content: 'function login() { /* ... */ }',
    chunkType: 'function',
    language: 'TypeScript',
    score: 0.9,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  it('tells the model explicitly when no chunks were retrieved, and does not invent context', () => {
    const prompt = buildSystemPrompt([]);

    expect(prompt).toMatch(/no relevant code/i);
    expect(prompt).toMatch(/could not find/i);
  });

  it('instructs the model to omit a citation rather than invent one when unsure', () => {
    const prompt = buildSystemPrompt([makeChunk()]);

    expect(prompt).toMatch(/never invent a citation/i);
  });

  it('does not contain a concrete example citation the model could mistake for real context', () => {
    // Regression test for a real bug: an earlier version of this prompt
    // included "e.g. [src/auth.ts:12-24]" as an example, and the model
    // occasionally treated that fake path as if it were part of the
    // actual retrieved context and cited it in its answer.
    const prompt = buildSystemPrompt([makeChunk({ filePath: 'src/db.ts' })]);

    expect(prompt).not.toContain('src/auth.ts');
  });

  it("includes each chunk's file path and line range in the citation instruction format", () => {
    const chunks = [makeChunk({ filePath: 'src/auth.ts', startLine: 10, endLine: 20 })];
    const prompt = buildSystemPrompt(chunks);

    expect(prompt).toContain('src/auth.ts:10-20');
  });

  it('instructs the model to cite using the exact [filepath:startLine-endLine] format', () => {
    const prompt = buildSystemPrompt([makeChunk()]);

    expect(prompt).toMatch(/\[filepath:startLine-endLine\]/);
  });

  it('instructs the model to say when it does not know rather than guess', () => {
    const prompt = buildSystemPrompt([makeChunk()]);

    expect(prompt).toMatch(/say so explicitly/i);
  });

  it('includes the symbol name when present, to give the model more context per chunk', () => {
    const prompt = buildSystemPrompt([makeChunk({ symbolName: 'UserService.login' })]);

    expect(prompt).toContain('UserService.login');
  });

  it('includes the actual chunk content so the model can quote/reference real code', () => {
    const prompt = buildSystemPrompt([makeChunk({ content: 'const SECRET_KEY = process.env.KEY;' })]);

    expect(prompt).toContain('const SECRET_KEY = process.env.KEY;');
  });
});

describe('extractCitations', () => {
  it('extracts a single citation in the expected format', () => {
    const citations = extractCitations('The login logic is here [src/auth.ts:10-20].');

    expect(citations).toEqual([{ filePath: 'src/auth.ts', startLine: 10, endLine: 20 }]);
  });

  it('extracts multiple distinct citations from the same text', () => {
    const citations = extractCitations(
      'See [src/auth.ts:10-20] for login and [src/db.ts:5-15] for the database layer.',
    );

    expect(citations).toEqual([
      { filePath: 'src/auth.ts', startLine: 10, endLine: 20 },
      { filePath: 'src/db.ts', startLine: 5, endLine: 15 },
    ]);
  });

  it('deduplicates repeated citations to the same location', () => {
    const citations = extractCitations(
      'The function is defined in [src/auth.ts:10-20]. As shown in [src/auth.ts:10-20], it validates input.',
    );

    expect(citations).toHaveLength(1);
  });

  it('returns an empty array when the text has no citations', () => {
    const citations = extractCitations('I could not find relevant code for this question.');

    expect(citations).toEqual([]);
  });

  it('handles nested paths correctly', () => {
    const citations = extractCitations('Defined in [src/services/auth/login.service.ts:1-5].');

    expect(citations).toEqual([{ filePath: 'src/services/auth/login.service.ts', startLine: 1, endLine: 5 }]);
  });
});
