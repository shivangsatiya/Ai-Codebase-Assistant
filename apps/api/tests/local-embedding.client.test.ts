import { LocalEmbeddingClient, type FeatureExtractor } from '../src/clients/local-embedding.client';

function fakeExtractorFactory(callLog: string[][]) {
  const extractor: FeatureExtractor = async (texts) => {
    callLog.push([...texts]);
    // Deterministic fake embedding: one number per text, based on its
    // position in the overall call log - just needs to be checkable,
    // not semantically meaningful.
    const vectors = texts.map((_text, i) => [callLog.length, i]);
    return { tolist: () => vectors };
  };
  return async () => extractor;
}

describe('LocalEmbeddingClient', () => {
  it('returns an empty array immediately for empty input, without loading the model', async () => {
    let factoryCalls = 0;
    const client = new LocalEmbeddingClient('fake-model', 32, async () => {
      factoryCalls++;
      return async () => ({ tolist: () => [] });
    });

    const result = await client.embedBatch([], 'document');

    expect(result).toEqual([]);
    expect(factoryCalls).toBe(0);
  });

  it('sends all texts in one call when under the batch size', async () => {
    const callLog: string[][] = [];
    const client = new LocalEmbeddingClient('fake-model', 32, fakeExtractorFactory(callLog));

    const embeddings = await client.embedBatch(['a', 'b', 'c'], 'document');

    expect(callLog).toHaveLength(1);
    expect(callLog[0]).toEqual(['a', 'b', 'c']);
    expect(embeddings).toHaveLength(3);
  });

  it('splits into multiple calls when texts exceed the batch size', async () => {
    const callLog: string[][] = [];
    const client = new LocalEmbeddingClient('fake-model', 2, fakeExtractorFactory(callLog));

    const texts = ['a', 'b', 'c', 'd', 'e'];
    const embeddings = await client.embedBatch(texts, 'document');

    // batch size 2, 5 items -> 3 calls: [a,b], [c,d], [e]
    expect(callLog).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(embeddings).toHaveLength(5);
  });

  it('loads the model only once across multiple embedBatch calls', async () => {
    let factoryCalls = 0;
    const client = new LocalEmbeddingClient('fake-model', 32, async () => {
      factoryCalls++;
      return async (texts: string[]) => ({ tolist: () => texts.map(() => [1]) });
    });

    await client.embedBatch(['a'], 'document');
    await client.embedBatch(['b'], 'query');
    await client.embedBatch(['c'], 'document');

    expect(factoryCalls).toBe(1);
  });

  it('accepts either inputType without it affecting behavior (no document/query distinction locally)', async () => {
    const callLog: string[][] = [];
    const client = new LocalEmbeddingClient('fake-model', 32, fakeExtractorFactory(callLog));

    const docEmbeddings = await client.embedBatch(['some code'], 'document');
    const queryEmbeddings = await client.embedBatch(['a question'], 'query');

    expect(docEmbeddings).toHaveLength(1);
    expect(queryEmbeddings).toHaveLength(1);
  });

  it('preserves order between input texts and returned embeddings across batches', async () => {
    const callLog: string[][] = [];
    const client = new LocalEmbeddingClient('fake-model', 2, fakeExtractorFactory(callLog));

    const embeddings = await client.embedBatch(['first', 'second', 'third'], 'document');

    // Batch 1 (['first','second']) produces vectors [[1,0],[1,1]];
    // batch 2 (['third']) produces [[2,0]] - confirms results are
    // concatenated in the same order the texts were given, not reordered.
    expect(embeddings).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
  });
});
