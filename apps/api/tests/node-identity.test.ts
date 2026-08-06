import {
  canonicalizePath,
  buildNodeId,
  buildEdgeId,
  buildNodeIdFromCandidate,
  buildEdgeIdFromCandidate,
  UnknownNodeTypeError,
} from '../src/services/knowledge-graph/node-identity';
import type { CandidateNode, CandidateEdge } from '../src/services/knowledge-graph/types';

describe('canonicalizePath', () => {
  it('normalizes Windows backslashes to forward slashes', () => {
    expect(canonicalizePath('src\\services\\auth.ts')).toBe('src/services/auth.ts');
  });

  it('normalizes a mix of separators to forward slashes', () => {
    expect(canonicalizePath('src\\services/auth.ts')).toBe('src/services/auth.ts');
  });

  it('leaves an already-forward-slash path unchanged', () => {
    expect(canonicalizePath('src/services/auth.ts')).toBe('src/services/auth.ts');
  });

  it('collapses repeated separators', () => {
    expect(canonicalizePath('src//services\\\\auth.ts')).toBe('src/services/auth.ts');
  });

  it('does NOT normalize casing - two differently-cased paths remain distinct', () => {
    // Deliberate: lowercasing could wrongly merge two genuinely
    // different files on a case-sensitive filesystem. This is the
    // specific behavior the design's own reasoning requires.
    expect(canonicalizePath('src/Auth.ts')).toBe('src/Auth.ts');
    expect(canonicalizePath('src/auth.ts')).not.toBe(canonicalizePath('src/Auth.ts'));
  });
});

describe('buildNodeId', () => {
  it('builds a file id with the canonicalized path', () => {
    expect(buildNodeId('file', ['src\\index.ts'])).toBe('file:src/index.ts');
  });

  it('builds a class id combining the canonicalized path and the class name', () => {
    expect(buildNodeId('class', ['src\\auth.ts', 'AuthService'])).toBe('class:src/auth.ts#AuthService');
  });

  it('builds a route id uppercasing the HTTP method but not canonicalizing the path as a file path', () => {
    expect(buildNodeId('route', ['post', '/api/auth/login'])).toBe('route:POST:/api/auth/login');
  });

  it('builds a package id directly from the package name, no canonicalization', () => {
    expect(buildNodeId('package', ['express'])).toBe('package:express');
  });

  it('builds a repository root id from the repository id alone', () => {
    expect(buildNodeId('repository', ['repo-123'])).toBe('repository:repo-123');
  });

  it('throws a clear error for an unregistered node type', () => {
    expect(() => buildNodeId('nonexistent-type', ['x'])).toThrow(UnknownNodeTypeError);
    expect(() => buildNodeId('nonexistent-type', ['x'])).toThrow(/nonexistent-type/);
  });

  it('two candidates for the identical file, with different path separator styles, produce the identical id', () => {
    // This is the specific property that prevents the Day 3-4-class bug
    // from recurring here: identity generation must be immune to
    // separator inconsistency between extraction runs or platforms.
    const idA = buildNodeId('file', ['src\\services\\auth.ts']);
    const idB = buildNodeId('file', ['src/services/auth.ts']);
    expect(idA).toBe(idB);
  });
});

describe('buildEdgeId', () => {
  it('combines source, type, and target into one stable id', () => {
    expect(buildEdgeId('file:a.ts', 'file:b.ts', 'imports')).toBe('edge:file:a.ts->imports->file:b.ts');
  });

  it('two edges with the same source, target, and type produce the identical id - the property deduplication depends on', () => {
    const idA = buildEdgeId('file:a.ts', 'file:b.ts', 'imports');
    const idB = buildEdgeId('file:a.ts', 'file:b.ts', 'imports');
    expect(idA).toBe(idB);
  });

  it('a different edge type between the same two nodes produces a different id', () => {
    const imports = buildEdgeId('file:a.ts', 'file:b.ts', 'imports');
    const calls = buildEdgeId('file:a.ts', 'file:b.ts', 'calls');
    expect(imports).not.toBe(calls);
  });
});

function makeCandidateNode(overrides: Partial<CandidateNode> = {}): CandidateNode {
  return {
    type: 'file',
    idComponents: ['src/index.ts'],
    label: 'index.ts',
    filePath: 'src/index.ts',
    metadata: {},
    source: 'DeterministicExtractor',
    sourceVersion: '1',
    certainty: 'deterministic',
    ...overrides,
  };
}

function makeCandidateEdge(overrides: Partial<CandidateEdge> = {}): CandidateEdge {
  return {
    type: 'imports',
    sourceType: 'file',
    sourceIdComponents: ['src/a.ts'],
    targetType: 'file',
    targetIdComponents: ['src/b.ts'],
    metadata: {},
    source: 'DeterministicExtractor',
    sourceVersion: '1',
    certainty: 'deterministic',
    ...overrides,
  };
}

describe('buildNodeIdFromCandidate / buildEdgeIdFromCandidate', () => {
  it('derives the node id from a candidate the same way buildNodeId does directly', () => {
    const candidate = makeCandidateNode({ type: 'class', idComponents: ['src/auth.ts', 'AuthService'] });
    expect(buildNodeIdFromCandidate(candidate)).toBe(buildNodeId('class', ['src/auth.ts', 'AuthService']));
  });

  it('derives the edge id by resolving both endpoints through the same node-id builders', () => {
    const candidate = makeCandidateEdge();
    const expected = buildEdgeId(buildNodeId('file', ['src/a.ts']), buildNodeId('file', ['src/b.ts']), 'imports');
    expect(buildEdgeIdFromCandidate(candidate)).toBe(expected);
  });
});
