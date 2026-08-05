import { Types } from 'mongoose';
import { ChunkModel } from '../models/chunk.model';

// Must match the Atlas Vector Search index name exactly - see README for
// the index definition to create in the Atlas UI (Search & Vector Search
// tab), since this can't be created through Mongoose/schema code.
export const VECTOR_INDEX_NAME = 'chunk_vector_index';

export interface ChunkToInsert {
  repositoryId: string;
  commitSha: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding: number[];
  language: string;
  symbolName?: string;
  chunkType: string;
  contentHash: string;
}

export interface InsertResult {
  inserted: number;
  skippedDuplicates: number;
}

export interface ChunkSearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  symbolName?: string;
  chunkType: string;
  language: string;
  score: number;
}

export interface IChunkRepository {
  insertManyIdempotent(chunks: ChunkToInsert[]): Promise<InsertResult>;
  countByRepository(repositoryId: string): Promise<number>;
  vectorSearch(repositoryId: string, queryVector: number[], limit: number): Promise<ChunkSearchResult[]>;
  deleteByRepository(repositoryId: string): Promise<void>;
}

interface MongoWriteError {
  code?: number;
  err?: { code?: number };
}

interface MongoBulkWriteError extends Error {
  code?: number;
  writeErrors?: MongoWriteError[];
  insertedDocs?: unknown[];
}

const DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Why check both e.code and e.err?.code?
 *
 * The MongoDB driver's WriteError class exposes `code` as a *getter* on
 * its prototype (`get code() { return this.err.code }`), not an own
 * property. Mongoose's own insertMany implementation reshapes each
 * writeErrors entry via object spread (`{ ...writeError, index }`) to
 * remap document indexes - but object spread only copies OWN enumerable
 * properties, so that getter is silently dropped. What survives the
 * spread is the raw `.err` object underneath, still holding the actual
 * code at `.err.code`. Checking `e.code` alone works against the raw
 * MongoDB driver error; checking `e.err?.code` is what's actually needed
 * after Mongoose's own transformation - this bit us for real: the
 * duplicate-key error was being rethrown as an unhandled failure instead
 * of being recognized as an expected, safe-to-skip outcome.
 */
function isDuplicateKeyError(writeError: MongoWriteError): boolean {
  return writeError.code === DUPLICATE_KEY_ERROR_CODE || writeError.err?.code === DUPLICATE_KEY_ERROR_CODE;
}

export class MongoChunkRepository implements IChunkRepository {
  /**
   * Why insertMany with { ordered: false } instead of checking for
   * existing chunks before inserting?
   *
   * A pre-check-then-insert approach has a race condition: two concurrent
   * imports (or a retried job) could both pass the check before either
   * inserts. `ordered: false` lets MongoDB attempt every document and
   * report back which ones hit the unique index - duplicates are a
   * normal, expected outcome of "we already indexed this exact chunk in
   * an earlier import," not an application error. Anything that ISN'T a
   * duplicate-key error (code 11000) is rethrown, since that's a genuine
   * problem (bad connection, validation failure, etc.).
   */
  async insertManyIdempotent(chunks: ChunkToInsert[]): Promise<InsertResult> {
    if (chunks.length === 0) {
      return { inserted: 0, skippedDuplicates: 0 };
    }

    try {
      await ChunkModel.insertMany(chunks, { ordered: false });
      return { inserted: chunks.length, skippedDuplicates: 0 };
    } catch (err) {
      const bulkError = err as MongoBulkWriteError;
      const writeErrors = bulkError.writeErrors ?? [];

      const allAreDuplicates = writeErrors.length > 0 && writeErrors.every(isDuplicateKeyError);
      if (!allAreDuplicates) {
        throw err;
      }

      const insertedCount = bulkError.insertedDocs?.length ?? chunks.length - writeErrors.length;
      return { inserted: insertedCount, skippedDuplicates: writeErrors.length };
    }
  }

  async countByRepository(repositoryId: string): Promise<number> {
    return ChunkModel.countDocuments({ repositoryId }).exec();
  }

  /**
   * Why the vector index name, `VECTOR_INDEX_NAME`, matter here?
   *
   * Atlas Vector Search indexes can't be created through Mongoose/schema
   * code at all - they're configured directly in the Atlas UI (or via
   * the Atlas Admin API), separate from normal MongoDB indexes. This
   * name has to match exactly what's configured there. See the project
   * README for the exact index definition to create.
   *
   * Why filter INSIDE the $vectorSearch stage rather than a separate
   * $match after it?
   *
   * Atlas Vector Search's `filter` option is applied during the
   * approximate-nearest-neighbor search itself, not after - filtering
   * post-hoc with $match could return fewer than `limit` results if many
   * of the globally-nearest vectors belong to other repositories. This
   * is the entire reason each chunk stores its own `repositoryId` field.
   */
  async vectorSearch(repositoryId: string, queryVector: number[], limit: number): Promise<ChunkSearchResult[]> {
    const results = await ChunkModel.aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector,
          numCandidates: Math.max(limit * 10, 100),
          limit,
          filter: { repositoryId: new Types.ObjectId(repositoryId) },
        },
      },
      {
        $project: {
          _id: 0,
          filePath: 1,
          startLine: 1,
          endLine: 1,
          content: 1,
          symbolName: 1,
          chunkType: 1,
          language: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]).exec();

    return results as ChunkSearchResult[];
  }

  async deleteByRepository(repositoryId: string): Promise<void> {
    await ChunkModel.deleteMany({ repositoryId }).exec();
  }
}
