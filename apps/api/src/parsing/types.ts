export type ChunkSource = 'ast' | 'line-window';

export interface RawChunk {
  startLine: number; // 1-indexed, inclusive
  endLine: number; // 1-indexed, inclusive
  content: string;
  symbolName?: string;
  chunkType: string; // e.g. 'function', 'method', 'class', 'line-window'
  source: ChunkSource;
}
