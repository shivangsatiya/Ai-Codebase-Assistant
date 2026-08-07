import type { CandidateNode, CandidateEdge } from './types';

/**
 * Path separator normalization only - matching this project's own real
 * precedent exactly (Day 3-4, chunk filePath values, Windows backslash
 * vs forward slash causing citation mismatches), not a broader guess.
 * Deliberately does NOT normalize casing: lowercasing could wrongly
 * merge two genuinely distinct files on a case-sensitive filesystem,
 * which the original bug never required fixing, so this doesn't
 * introduce a new assumption beyond what's actually proven necessary.
 */
export function canonicalizePath(rawPath: string): string {
  return rawPath.split(/[\\/]+/).filter(Boolean).join('/');
}

/**
 * One explicit builder function per node type - the concrete mechanism
 * behind "adding a new type is a code change, never a database
 * migration": a future type is one new entry here, nothing else.
 * Each builder decides for itself which of its components are
 * path-shaped (and need canonicalizing) versus plain strings (an HTTP
 * method, a package name) - canonicalization isn't blindly applied to
 * every component, since not every component is a path.
 */
const NODE_ID_BUILDERS: Record<string, (components: string[]) => string> = {
  repository: (c) => `repository:${c[0]}`,
  folder: (c) => `folder:${canonicalizePath(c[0]!)}`,
  file: (c) => `file:${canonicalizePath(c[0]!)}`,
  class: (c) => `class:${canonicalizePath(c[0]!)}#${c[1]}`,
  interface: (c) => `interface:${canonicalizePath(c[0]!)}#${c[1]}`,
  function: (c) => `function:${canonicalizePath(c[0]!)}#${c[1]}`,
  method: (c) => `method:${canonicalizePath(c[0]!)}#${c[1]}`,
  package: (c) => `package:${c[0]}`,
  route: (c) => `route:${c[0]!.toUpperCase()}:${c[1]}`,
  // Tier 3 (InferredAnnotationExtractor) types - identity-scoped to the
  // file that defines them, the same scheme as class/function/method,
  // since a file/annotation classification is inherently per-file at
  // this project's current extraction granularity.
  service: (c) => `service:${canonicalizePath(c[0]!)}`,
  controller: (c) => `controller:${canonicalizePath(c[0]!)}`,
  dbModel: (c) => `dbModel:${canonicalizePath(c[0]!)}`,
  cache: (c) => `cache:${canonicalizePath(c[0]!)}`,
  queue: (c) => `queue:${canonicalizePath(c[0]!)}`,
  event: (c) => `event:${canonicalizePath(c[0]!)}`,
  configuration: (c) => `configuration:${canonicalizePath(c[0]!)}`,
  authComponent: (c) => `authComponent:${canonicalizePath(c[0]!)}`,
};

export class UnknownNodeTypeError extends Error {
  constructor(type: string) {
    super(`No identity builder registered for node type "${type}"`);
  }
}

export function buildNodeId(type: string, idComponents: string[]): string {
  const builder = NODE_ID_BUILDERS[type];
  if (!builder) {
    throw new UnknownNodeTypeError(type);
  }
  return builder(idComponents);
}

export function buildNodeIdFromCandidate(candidate: CandidateNode): string {
  return buildNodeId(candidate.type, candidate.idComponents);
}

/**
 * An edge's id is derived from its resolved endpoints and type, not
 * given its own separate identity scheme - two candidate edges
 * describing the identical relationship (same source, same target,
 * same type) always produce the identical edge id, which is exactly
 * what makes deduplication possible.
 */
export function buildEdgeId(sourceNodeId: string, targetNodeId: string, edgeType: string): string {
  return `edge:${sourceNodeId}->${edgeType}->${targetNodeId}`;
}

export function buildEdgeIdFromCandidate(candidate: CandidateEdge): string {
  const sourceId = buildNodeId(candidate.sourceType, candidate.sourceIdComponents);
  const targetId = buildNodeId(candidate.targetType, candidate.targetIdComponents);
  return buildEdgeId(sourceId, targetId, candidate.type);
}
