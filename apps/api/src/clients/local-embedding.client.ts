import { pipeline } from '@huggingface/transformers';
import { logger } from '../utils/logger';
import type { IEmbeddingProvider, EmbeddingInputType } from './embedding-provider';

export interface EmbeddingTensor {
  tolist(): number[][];
}

export type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<EmbeddingTensor>;

/**
 * Why run embeddings locally instead of calling a third-party API?
 *
 * After real trouble with Voyage AI's free tier (an account-provisioning
 * bug that made every request fail regardless of actual usage, confirmed
 * via their own dashboard showing zero recorded usage) and OpenAI
 * requiring a payment method, running the embedding model in-process
 * removes the entire category of problem: no API key, no account that
 * can misbehave, no rate limit, no per-token cost, and no network
 * dependency at inference time (only the one-time model download on
 * first use). The tradeoff is real and worth naming honestly: a general-
 * purpose sentence embedding model (not code-specific like Voyage's),
 * and CPU-bound local inference is slower than a cloud API for very
 * large repos. For a portfolio-scale project, that tradeoff is the right
 * one - reliability and zero ongoing cost over marginally better
 * code-specific retrieval quality.
 *
 * Why all-MiniLM-L6-v2 specifically?
 *
 * It's one of the most widely used, well-tested sentence embedding
 * models with transformers.js - small (~90MB at full precision), fast on
 * CPU, and its ONNX export is maintained specifically for this library,
 * which matters after already being burned once by an ONNX/runtime
 * version mismatch (the tree-sitter-wasms situation from Day 3-4).
 *
 * Why dtype: 'q8' (8-bit quantization) specifically?
 *
 * The first real deployment to Render's free tier crashed with a
 * confirmed OOM kill ("Ran out of memory (used over 512MB)") while
 * loading this exact model - without an explicit dtype, the library
 * loads the full fp32-precision weights, using roughly 4x the memory of
 * an 8-bit quantized version for the same model. Quantization has a
 * well-established, minimal quality impact specifically for sentence
 * embedding models (a few percent at most in standard retrieval
 * benchmarks) - a fully justified trade-off here, both for fitting
 * inside a constrained memory budget and because this project already
 * accepted "general-purpose, not code-specific" as a quality trade-off
 * for local embeddings in the first place.
 */
const DEFAULT_MODEL = 'onnx-community/all-MiniLM-L6-v2-ONNX';
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_DTYPE = 'q8';

export class LocalEmbeddingClient implements IEmbeddingProvider {
  private readonly modelName: string;
  private readonly batchSize: number;
  private readonly extractorFactory: () => Promise<FeatureExtractor>;
  private extractorPromise: Promise<FeatureExtractor> | null = null;

  constructor(
    modelName: string = DEFAULT_MODEL,
    batchSize: number = DEFAULT_BATCH_SIZE,
    /**
     * Injected for tests - a fake extractor lets tests verify our own
     * batching and tensor-to-array mapping logic without ever
     * downloading the real model or running actual inference.
     * Production wiring (the composition root) uses the default, which
     * lazily loads the real, quantized model on first use.
     */
    extractorFactory?: () => Promise<FeatureExtractor>,
  ) {
    this.modelName = modelName;
    this.batchSize = batchSize;
    this.extractorFactory =
      extractorFactory ??
      (() =>
        pipeline('feature-extraction', this.modelName, {
          dtype: DEFAULT_DTYPE,
        }) as unknown as Promise<FeatureExtractor>);
  }

  /**
   * Why lazy-load and cache the pipeline instead of loading it in the
   * constructor?
   *
   * The composition root constructs this client once at server startup,
   * but the actual model (a real download + ONNX runtime initialization
   * on first use) shouldn't block the server from starting up - it loads
   * once, on the first repository import, and every import after that
   * reuses the already-loaded model instance.
   */
  private async getExtractor(): Promise<FeatureExtractor> {
    if (!this.extractorPromise) {
      logger.info({ model: this.modelName }, 'Loading local embedding model (first use downloads and caches it)');
      this.extractorPromise = this.extractorFactory();
    }
    return this.extractorPromise;
  }

  /**
   * Why is inputType accepted but ignored here?
   *
   * Voyage's code models support asymmetric embeddings (a 'document'
   * hint for indexed code vs a 'query' hint for a search question).
   * all-MiniLM-L6-v2 has no such distinction - keeping the parameter in
   * the shared IEmbeddingProvider interface means the rest of the
   * pipeline (ChunkingService, the future chat retrieval service)
   * doesn't need to know or care which provider is actually configured.
   */
  async embedBatch(texts: string[], _inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.getExtractor();
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      allEmbeddings.push(...output.tolist());
    }

    return allEmbeddings;
  }
}