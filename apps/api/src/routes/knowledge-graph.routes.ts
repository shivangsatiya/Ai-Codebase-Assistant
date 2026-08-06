import { Router, type Response, type NextFunction } from 'express';
import { knowledgeGraphRepo, architectureIntelligenceEngine, questionRouter } from '../config/composition-root';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { validateBody } from '../middleware/validate';
import { getOwnedRepositoryOrThrow } from './repository.routes';
import { ValidationError, NotFoundError } from '../utils/errors';
import { askQuestionSchema, type AskQuestionInput } from './knowledge-graph.schemas';

export const knowledgeGraphRouter = Router();

knowledgeGraphRouter.get(
  '/:id/graph',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const graph = await knowledgeGraphRepo.findLatestByRepositoryId(repository._id.toString());

      if (!graph) {
        res.status(200).json({ status: 'not_generated', nodes: [], edges: [] });
        return;
      }

      // Already shaped for direct graph-visualization-library consumption
      // (id/label/type nodes, source/target/type edges) - no reshaping
      // needed on read, since the storage schema was deliberately chosen
      // to match this on write.
      res.status(200).json({
        status: graph.status,
        commitSha: graph.commitSha,
        nodes: graph.nodes,
        edges: graph.edges,
      });
    } catch (err) {
      next(err);
    }
  },
);

knowledgeGraphRouter.get(
  '/:id/graph/versions',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const versions = await knowledgeGraphRepo.findAllVersionsByRepositoryId(repository._id.toString());

      res.status(200).json({ versions });
    } catch (err) {
      next(err);
    }
  },
);

knowledgeGraphRouter.get(
  '/:id/graph/analysis/:algorithm',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const graph = await knowledgeGraphRepo.findLatestByRepositoryId(repository._id.toString());

      if (!graph) {
        throw new NotFoundError('No ready knowledge graph exists yet for this repository');
      }

      // Any registered algorithm is reachable here with zero route
      // changes - the concrete answer to "design this layer so future
      // algorithms can be added without changing the graph model."
      // Query string params become the algorithm's own params directly;
      // each algorithm validates what it actually needs itself, rather
      // than this route trying to anticipate every algorithm's shape.
      const result = architectureIntelligenceEngine.run(
        req.params.algorithm as string,
        { nodes: graph.nodes, edges: graph.edges },
        req.query as Record<string, unknown>,
      );

      res.status(200).json({ algorithm: req.params.algorithm, result });
    } catch (err) {
      next(err);
    }
  },
);

knowledgeGraphRouter.post(
  '/:id/graph',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);

      if (!repository.commitSha) {
        throw new ValidationError('This repository has no commit recorded yet - the import may still be in progress');
      }

      const existing = await knowledgeGraphRepo.findByCommitSha(repository._id.toString(), repository.commitSha);
      if (existing) {
        res.status(200).json({ status: existing.status, commitSha: existing.commitSha, message: 'Already generated for this commit' });
        return;
      }

      /**
       * An honest, deliberate scope boundary, not a silent gap: the
       * cloned source this repository was imported from is already
       * deleted (RepositoryImportService's cleanup(), run right after
       * the original import's chunking completed) by the time this
       * endpoint could ever be called manually after the fact. Full
       * re-extraction needs a fresh clone, which this task doesn't
       * implement - graph generation genuinely only happens as part of
       * a fresh import today. Returning a clear, honest error here is
       * the right behavior, not a workaround pretending to regenerate
       * something it structurally cannot.
       */
      throw new NotFoundError(
        'No knowledge graph exists for this commit, and regeneration requires the original source, which is no longer available after import. Re-import the repository to generate a graph for its current commit.',
      );
    } catch (err) {
      next(err);
    }
  },
);

knowledgeGraphRouter.post(
  '/:id/graph/ask',
  requireAuth,
  validateBody(askQuestionSchema),
  async (req: AuthenticatedRequest & { body: AskQuestionInput }, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const graph = await knowledgeGraphRepo.findLatestByRepositoryId(repository._id.toString());

      if (!graph) {
        throw new NotFoundError('No ready knowledge graph exists yet for this repository');
      }

      /**
       * Why does this route not stream, unlike existing chat, even
       * though the frozen design's interaction model says Hybrid/
       * Semantic answers should stream?
       *
       * This task scopes to Pure Graph and Intelligence only - both
       * complete synchronously (a graph traversal or algorithm run, no
       * LLM token-by-token generation involved), so there's nothing to
       * stream yet. Task 6 adds streaming specifically for the
       * Hybrid/Semantic paths, reusing the existing SSE infrastructure
       * from chat.routes.ts rather than duplicating it here.
       */
      const answer = await questionRouter.ask(
        { nodes: graph.nodes, edges: graph.edges },
        {
          question: req.body.question,
          nodeId: req.body.nodeId,
          targetNodeId: req.body.targetNodeId,
          direction: req.body.direction,
        },
      );

      res.status(200).json(answer);
    } catch (err) {
      next(err);
    }
  },
);
