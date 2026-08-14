import {
  DeterministicExtractor,
  type ExtractorFileInput,
  type ExtractorSymbolInput,
} from '../src/services/knowledge-graph/deterministic-extractor';
import { RepositoryIntelligencePipeline } from '../src/services/knowledge-graph/repository-intelligence-pipeline';
import type {
  IRepositoryKnowledgeGraphRepository,
  InsertGraphInput,
} from '../src/repositories/repository-knowledge-graph.repository';
import type { RepositoryKnowledgeGraphDocument, GraphStatus } from '../src/models/repository-knowledge-graph.model';

class FakeGraphRepository implements IRepositoryKnowledgeGraphRepository {
  public inserted: InsertGraphInput[] = [];

  async insert(input: InsertGraphInput): Promise<RepositoryKnowledgeGraphDocument> {
    this.inserted.push(input);
    return { ...input, _id: { toString: () => 'fake-id' } } as unknown as RepositoryKnowledgeGraphDocument;
  }

  async findByCommitSha(): Promise<RepositoryKnowledgeGraphDocument | null> {
    return null;
  }

  async findLatestByRepositoryId(): Promise<RepositoryKnowledgeGraphDocument | null> {
    return null;
  }

  async findAllVersionsByRepositoryId(): Promise<Array<{ commitSha: string; status: GraphStatus; createdAt: Date }>> {
    return [];
  }

  async deleteByRepositoryId(): Promise<void> {
    // no-op - not exercised by these tests
  }
}

describe('DeterministicExtractor - folders, files, containment', () => {
  it('produces a folder node, a file node, and contains edges connecting both to the repository root', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/index.ts', content: '', extension: '.ts' }];

    const { nodes, edges } = await extractor.extract('repo-1', files, []);

    expect(nodes.find((n) => n.type === 'folder' && n.idComponents[0] === 'src')).toBeDefined();
    expect(nodes.find((n) => n.type === 'file' && n.idComponents[0] === 'src/index.ts')).toBeDefined();

    const rootToFolder = edges.find((e) => e.type === 'contains' && e.sourceType === 'repository' && e.targetIdComponents[0] === 'src');
    const folderToFile = edges.find((e) => e.type === 'contains' && e.sourceType === 'folder' && e.targetIdComponents[0] === 'src/index.ts');
    expect(rootToFolder).toBeDefined();
    expect(folderToFile).toBeDefined();
  });

  it('connects a top-level file (no folder) directly to the repository root', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'index.ts', content: '', extension: '.ts' }];

    const { edges } = await extractor.extract('repo-1', files, []);

    const rootToFile = edges.find((e) => e.type === 'contains' && e.sourceType === 'repository' && e.targetIdComponents[0] === 'index.ts');
    expect(rootToFile).toBeDefined();
  });

  it('does not produce duplicate folder nodes for a folder shared by multiple files', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/a.ts', content: '', extension: '.ts' },
      { relativePath: 'src/b.ts', content: '', extension: '.ts' },
    ];

    const { nodes } = await extractor.extract('repo-1', files, []);

    const srcFolders = nodes.filter((n) => n.type === 'folder' && n.idComponents[0] === 'src');
    expect(srcFolders).toHaveLength(1);
  });

  it('produces the full nested folder chain for a deeply-nested file', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/services/auth/login.ts', content: '', extension: '.ts' }];

    const { nodes, edges } = await extractor.extract('repo-1', files, []);

    expect(nodes.filter((n) => n.type === 'folder')).toHaveLength(3); // src, src/services, src/services/auth
    expect(edges.find((e) => e.sourceType === 'repository')).toBeDefined();
    expect(edges.find((e) => e.sourceIdComponents[0] === 'src' && e.targetIdComponents[0] === 'src/services')).toBeDefined();
    expect(edges.find((e) => e.sourceIdComponents[0] === 'src/services' && e.targetIdComponents[0] === 'src/services/auth')).toBeDefined();
  });
});

describe('DeterministicExtractor - symbols', () => {
  it('produces a node and a contains edge for a class symbol', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/auth.ts', content: '', extension: '.ts' }];
    const symbols: ExtractorSymbolInput[] = [
      { filePath: 'src/auth.ts', chunkType: 'class', symbolName: 'AuthService', language: 'TypeScript' },
    ];

    const { nodes, edges } = await extractor.extract('repo-1', files, symbols);

    const classNode = nodes.find((n) => n.type === 'class');
    expect(classNode).toBeDefined();
    expect(classNode!.label).toBe('AuthService');
    expect(edges.find((e) => e.type === 'contains' && e.sourceType === 'file' && e.targetType === 'class')).toBeDefined();
  });

  it('skips a line-window chunk - not a named symbol, just a fallback slice', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/config.ts', content: '', extension: '.ts' }];
    const symbols: ExtractorSymbolInput[] = [{ filePath: 'src/config.ts', chunkType: 'line-window', language: 'TypeScript' }];

    const { nodes } = await extractor.extract('repo-1', files, symbols);

    expect(nodes.find((n) => n.type === 'line-window')).toBeUndefined();
  });
});

describe('DeterministicExtractor - imports', () => {
  it('resolves a relative import to another known file in the repo', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/index.ts', content: `import { foo } from './foo';`, extension: '.ts' },
      { relativePath: 'src/foo.ts', content: '', extension: '.ts' },
    ];

    const { edges } = await extractor.extract('repo-1', files, []);

    const importEdge = edges.find((e) => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.sourceIdComponents[0]).toBe('src/index.ts');
    expect(importEdge!.targetType).toBe('file');
    expect(importEdge!.targetIdComponents[0]).toBe('src/foo.ts');
  });

  it('resolves a relative import missing its extension against known files', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/index.ts', content: `const x = require('./utils');`, extension: '.ts' },
      { relativePath: 'src/utils.ts', content: '', extension: '.ts' },
    ];

    const { edges } = await extractor.extract('repo-1', files, []);

    const importEdge = edges.find((e) => e.type === 'imports');
    expect(importEdge!.targetIdComponents[0]).toBe('src/utils.ts');
  });

  it('produces an external package node and edge for a bare specifier', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/index.ts', content: `import express from 'express';`, extension: '.ts' }];

    const { nodes, edges } = await extractor.extract('repo-1', files, []);

    expect(nodes.find((n) => n.type === 'package' && n.idComponents[0] === 'express')).toBeDefined();
    const importEdge = edges.find((e) => e.type === 'imports' && e.targetType === 'package');
    expect(importEdge!.targetIdComponents[0]).toBe('express');
  });

  it('does not emit an edge for a relative import that cannot be resolved - honest, not a guess', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [{ relativePath: 'src/index.ts', content: `import { x } from './does-not-exist';`, extension: '.ts' }];

    const { edges } = await extractor.extract('repo-1', files, []);

    expect(edges.find((e) => e.type === 'imports')).toBeUndefined();
  });

  it('deduplicates a package node imported by multiple files into one node', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/a.ts', content: `import express from 'express';`, extension: '.ts' },
      { relativePath: 'src/b.ts', content: `import express from 'express';`, extension: '.ts' },
    ];

    const { nodes } = await extractor.extract('repo-1', files, []);

    expect(nodes.filter((n) => n.type === 'package' && n.idComponents[0] === 'express')).toHaveLength(1);
  });

  it('extracts the package name from a subpath import, not the full subpath - a real bug caught by self-review', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/index.ts', content: `import debounce from 'lodash/debounce';`, extension: '.ts' },
    ];

    const { nodes } = await extractor.extract('repo-1', files, []);

    expect(nodes.find((n) => n.type === 'package' && n.idComponents[0] === 'lodash')).toBeDefined();
    expect(nodes.find((n) => n.idComponents[0] === 'lodash/debounce')).toBeUndefined();
  });

  it('extracts a scoped package name as the first two segments, not just the scope', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/index.ts', content: `import { foo } from '@org/pkg/subpath';`, extension: '.ts' },
    ];

    const { nodes } = await extractor.extract('repo-1', files, []);

    expect(nodes.find((n) => n.type === 'package' && n.idComponents[0] === '@org/pkg')).toBeDefined();
  });
});

describe('DeterministicExtractor - end to end through the real pipeline', () => {
  it('a real small repo structure produces candidates that the Repository Intelligence Pipeline actually approves as a ready graph', async () => {
    const extractor = new DeterministicExtractor();
    const files: ExtractorFileInput[] = [
      { relativePath: 'src/index.ts', content: `import { AuthService } from './services/auth';`, extension: '.ts' },
      {
        relativePath: 'src/services/auth.ts',
        content: `import express from 'express';\nexport class AuthService {}`,
        extension: '.ts',
      },
    ];
    const symbols: ExtractorSymbolInput[] = [
      { filePath: 'src/services/auth.ts', chunkType: 'class', symbolName: 'AuthService', language: 'TypeScript' },
    ];

    const { nodes, edges } = await extractor.extract('repo-1', files, symbols);

    const repo = new FakeGraphRepository();
    const pipeline = new RepositoryIntelligencePipeline(repo);
    const result = await pipeline.process('repo-1', 'commit-abc', nodes, edges);

    // This is the real proof this task set out to deliver: a genuine
    // extractor feeding genuine candidates through the genuine pipeline
    // built in Task 1, ending in an actually-approved graph - not two
    // components independently unit-tested and merely assumed to fit
    // together.
    expect(result.status).toBe('ready');
    expect(result.nodes!.find((n) => n.type === 'class' && n.label === 'AuthService')).toBeDefined();
    expect(result.nodes!.find((n) => n.type === 'package' && n.id === 'package:express')).toBeDefined();
    expect(result.edges!.find((e) => e.type === 'imports' && e.target.startsWith('file:src/services/auth'))).toBeDefined();
  });
});
