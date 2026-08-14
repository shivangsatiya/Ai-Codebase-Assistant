import type { IChatCompletionProvider } from '../../clients/chat-completion-provider';
import type { ExtractorFileInput } from './deterministic-extractor';
import type { CandidateNode, CandidateEdge } from './types';
import { logger } from '../../utils/logger';

const SOURCE = 'InferredAnnotationExtractor';
const SOURCE_VERSION = '1';

interface InferredAnnotationResult {
  isRoute: boolean;
  httpMethod: string | null;
  httpPath: string | null;
  isService: boolean;
  isController: boolean;
  isDbModel: boolean;
  isCache: boolean;
  isQueue: boolean;
  isEvent: boolean;
  isConfiguration: boolean;
  isAuthComponent: boolean;
  entityName: string | null;
}

const ANNOTATION_SYSTEM_PROMPT = [
  'You classify a single source code file for a repository architecture graph.',
  'Respond with ONLY a single JSON object, no other text, no markdown code fences.',
  'The JSON must have exactly these fields:',
  '{"isRoute": boolean, "httpMethod": string|null, "httpPath": string|null, "isService": boolean, "isController": boolean, "isDbModel": boolean, "isCache": boolean, "isQueue": boolean, "isEvent": boolean, "isConfiguration": boolean, "isAuthComponent": boolean, "entityName": string|null}',
  'Set a field true only if the file genuinely and primarily serves that architectural role - a file that merely imports or references something (e.g. imports a caching library once) is not itself that thing.',
  'entityName should be the primary class or exported symbol name this file defines, or null if there is no clear single name.',
  'If you are not confident about a classification, set it to false rather than guessing.',
].join(' ');

/**
 * Why one LLM call per file, not one call for a batch of files at once?
 *
 * A single-file classification is a small, simple JSON shape - reliable
 * to parse. Asking for a JSON ARRAY covering several files in one
 * response is more failure-prone (one malformed entry can corrupt
 * parsing for every file in that batch) for a modest cost saving.
 *
 * A real, confirmed limitation, updated here during Milestone 4 Task 5's
 * own benchmark work: this comment previously cited MAX_REPO_FILES=15 as
 * the reason batching wasn't worth the complexity - a genuinely stale
 * number, confirmed directly during Task 5's own inspection step to
 * actually be 3000. At that real scale, one-call-per-file is a real,
 * measured bottleneck, not a theoretical one - a repository near that
 * ceiling makes thousands of individual LLM calls, and this project's
 * free-tier Groq quota (100,000 tokens/day) is nowhere near enough to
 * complete inferred extraction for a repository that size in one run.
 * Batching would be the real fix, but implementing it is explicitly out
 * of scope for a measurement-only task - this comment update, and the
 * quota-exhaustion tracking below, exist to make that real constraint
 * visible and honestly measured, not to solve it here.
 */
export class InferredAnnotationExtractor {
  constructor(private readonly llmProvider: IChatCompletionProvider) {}

  async extract(files: ExtractorFileInput[]): Promise<{ nodes: CandidateNode[]; edges: CandidateEdge[] }> {
    const nodes: CandidateNode[] = [];
    const edges: CandidateEdge[] = [];

    // Milestone 4 Task 5 - measurement only, no change to the existing
    // per-file, no-retry, graceful-skip behavior itself (explicit
    // instruction: preserve it exactly, just measure it honestly).
    // Distinguishes quota exhaustion (a real, typed 429 from Groq's own
    // SDK - see groq-chat.client.ts, which lets this genuine error
    // surface rather than swallowing it as a generic failure) from every
    // other kind of inferred-extraction failure, since the two mean
    // genuinely different things for a capacity report: one is "the free
    // tier's real ceiling," the other is "something else went wrong."
    let succeededCount = 0;
    let quotaExhaustedCount = 0;
    let otherFailureCount = 0;
    let firstQuotaExhaustedAtFile: string | null = null;

    for (const file of files) {
      const outcome = await this.classifyFile(file);
      if (outcome.result) {
        succeededCount++;
        this.addNodesForAnnotation(file, outcome.result, nodes, edges);
      } else if (outcome.failureReason === 'quota_exhausted') {
        quotaExhaustedCount++;
        if (firstQuotaExhaustedAtFile === null) {
          firstQuotaExhaustedAtFile = file.relativePath;
        }
      } else {
        otherFailureCount++;
      }
    }

    const attemptedCount = files.length;
    const inferredCoveragePercent =
      attemptedCount > 0 ? Math.round((succeededCount / attemptedCount) * 1000) / 10 : 0;

    logger.info(
      {
        attemptedCount,
        succeededCount,
        quotaExhaustedCount,
        otherFailureCount,
        inferredCoveragePercent,
        firstQuotaExhaustedAtFile,
      },
      'Inferred (LLM) extraction coverage summary',
    );

    return { nodes, edges };
  }

  private async classifyFile(
    file: ExtractorFileInput,
  ): Promise<{ result: InferredAnnotationResult | null; failureReason?: 'quota_exhausted' | 'other' }> {
    try {
      const truncatedContent = file.content.slice(0, 4000); // keep the prompt small and bounded regardless of file size
      let fullResponse = '';

      for await (const token of this.llmProvider.streamCompletion({
        systemPrompt: ANNOTATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `File path: ${file.relativePath}\n\nContent:\n${truncatedContent}` }],
      })) {
        fullResponse += token;
      }

      return { result: this.parseAnnotation(fullResponse) };
    } catch (err) {
      // Real, typed detection - not a message-text guess. Confirmed
      // directly against groq-sdk's own real error hierarchy:
      // RateLimitError extends APIError<429, ...>.
      const isQuotaExhausted =
        err !== null && typeof err === 'object' && 'status' in err && (err as { status: unknown }).status === 429;
      logger.warn(
        { err, filePath: file.relativePath, isQuotaExhausted },
        'Inferred annotation extraction failed for this file - skipped, not guessed',
      );
      return { result: null, failureReason: isQuotaExhausted ? 'quota_exhausted' : 'other' };
    }
  }

  /**
   * Why strip markdown code fences before parsing, given the prompt
   * explicitly says not to include them?
   *
   * LLMs following an "only JSON" instruction still sometimes wrap the
   * response in ```json fences anyway - defensive parsing here costs
   * nothing and avoids treating a well-formed-but-fenced response as a
   * parse failure it isn't.
   */
  private parseAnnotation(raw: string): InferredAnnotationResult | null {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '');

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) return null;
    const p = parsed as Record<string, unknown>;

    const requiredBooleanFields = [
      'isRoute',
      'isService',
      'isController',
      'isDbModel',
      'isCache',
      'isQueue',
      'isEvent',
      'isConfiguration',
      'isAuthComponent',
    ];
    if (!requiredBooleanFields.every((f) => typeof p[f] === 'boolean')) return null;

    return {
      isRoute: p.isRoute as boolean,
      httpMethod: typeof p.httpMethod === 'string' ? p.httpMethod : null,
      httpPath: typeof p.httpPath === 'string' ? p.httpPath : null,
      isService: p.isService as boolean,
      isController: p.isController as boolean,
      isDbModel: p.isDbModel as boolean,
      isCache: p.isCache as boolean,
      isQueue: p.isQueue as boolean,
      isEvent: p.isEvent as boolean,
      isConfiguration: p.isConfiguration as boolean,
      isAuthComponent: p.isAuthComponent as boolean,
      entityName: typeof p.entityName === 'string' ? p.entityName : null,
    };
  }

  private addNodesForAnnotation(
    file: ExtractorFileInput,
    annotation: InferredAnnotationResult,
    nodes: CandidateNode[],
    edges: CandidateEdge[],
  ): void {
    const label = annotation.entityName ?? file.relativePath;

    const flagToType: Array<[boolean, string]> = [
      [annotation.isService, 'service'],
      [annotation.isController, 'controller'],
      [annotation.isDbModel, 'dbModel'],
      [annotation.isCache, 'cache'],
      [annotation.isQueue, 'queue'],
      [annotation.isEvent, 'event'],
      [annotation.isConfiguration, 'configuration'],
      [annotation.isAuthComponent, 'authComponent'],
    ];

    for (const [flag, type] of flagToType) {
      if (!flag) continue;
      this.addInferredNode(file, type, label, {}, nodes, edges);
    }

    if (annotation.isRoute) {
      // A real identity mismatch found while wiring this up: route
      // nodes are identity-scoped by (httpMethod, httpPath) - the same
      // scheme node-identity.ts's existing route builder already uses
      // for Tier 1/2 - not by file path like every other inferred type
      // here. If the LLM marked isRoute true but couldn't confidently
      // determine both method and path, there's no way to build a
      // correct route identity - skipped honestly rather than guessed
      // or built with a mismatched id shape.
      if (annotation.httpMethod && annotation.httpPath) {
        nodes.push({
          type: 'route',
          idComponents: [annotation.httpMethod, annotation.httpPath],
          label: `${annotation.httpMethod} ${annotation.httpPath}`,
          filePath: file.relativePath,
          metadata: {},
          source: SOURCE,
          sourceVersion: SOURCE_VERSION,
          certainty: 'inferred',
        });

        edges.push({
          type: 'defines',
          sourceType: 'file',
          sourceIdComponents: [file.relativePath],
          targetType: 'route',
          targetIdComponents: [annotation.httpMethod, annotation.httpPath],
          metadata: {},
          source: SOURCE,
          sourceVersion: SOURCE_VERSION,
          certainty: 'inferred',
        });
      }
    }
  }

  private addInferredNode(
    file: ExtractorFileInput,
    type: string,
    label: string,
    metadata: Record<string, unknown>,
    nodes: CandidateNode[],
    edges: CandidateEdge[],
  ): void {
    // idComponents reuse the SAME file path already used by Tier 1's
    // file node - a route/service/etc is identity-scoped to the file
    // that defines it, keeping this new node's id stable and derivable
    // the same way every other node's id already is.
    nodes.push({
      type,
      idComponents: [file.relativePath],
      label,
      filePath: file.relativePath,
      metadata,
      source: SOURCE,
      sourceVersion: SOURCE_VERSION,
      certainty: 'inferred',
    });

    edges.push({
      type: 'defines',
      sourceType: 'file',
      sourceIdComponents: [file.relativePath],
      targetType: type,
      targetIdComponents: [file.relativePath],
      metadata: {},
      source: SOURCE,
      sourceVersion: SOURCE_VERSION,
      certainty: 'inferred',
    });
  }
}
