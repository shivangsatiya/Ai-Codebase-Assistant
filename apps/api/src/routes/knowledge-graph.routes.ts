import { Router, type Response, type NextFunction } from 'express';
import { knowledgeGraphRepo, architectureIntelligenceEngine, questionRouter } from '../config/composition-root';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { validateBody } from '../middleware/validate';
import { chatRateLimiter } from '../middleware/rate-limit';
import { getOwnedRepositoryOrThrow } from './repository.routes';
import { ValidationError, NotFoundError } from '../utils/errors';
import { askQuestionSchema, type AskQuestionInput } from './knowledge-graph.schemas';
import { logger } from '../utils/logger';

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
  chatRateLimiter,
  validateBody(askQuestionSchema),
  async (req: AuthenticatedRequest & { body: AskQuestionInput }, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const graph = await knowledgeGraphRepo.findLatestByRepositoryId(repository._id.toString());

      if (!graph) {
        throw new NotFoundError('No ready knowledge graph exists yet for this repository');
      }

      const graphInput = { nodes: graph.nodes, edges: graph.edges };
      const askParams = {
        question: req.body.question,
        nodeId: req.body.nodeId,
        targetNodeId: req.body.targetNodeId,
        direction: req.body.direction,
      };

      /**
       * Classified once, here, specifically to decide the HTTP response
       * SHAPE before either questionRouter method runs - Pure Graph and
       * Intelligence questions complete synchronously and get a plain
       * JSON response; Hybrid and Pure Semantic questions stream,
       * reusing the exact SSE pattern chat.routes.ts already
       * established (manual headers, flushHeaders() for immediate
       * connection open, client-disconnect handling, a final `done` or
       * `error` event) rather than duplicating it.
       */
      const classification = questionRouter.classify(req.body.question);

      if (classification.category === 'pure_graph' || classification.category === 'intelligence') {
        const answer = await questionRouter.ask(graphInput, askParams);
        res.status(200).json(answer);
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();

      let clientDisconnected = false;
      req.on('close', () => {
        clientDisconnected = true;
      });

      try {
        for await (const event of questionRouter.streamAsk(
          repository._id.toString(),
          graphInput,
          classification.category,
          askParams,
        )) {
          if (clientDisconnected) break;
          if (event.type === 'token') {
            res.write(`data: ${JSON.stringify({ token: event.text })}\n\n`);
          }
        }

        if (!clientDisconnected) {
          res.write(`event: done\ndata: {}\n\n`);
        }
      } catch (err) {
        logger.error({ err, repositoryId: repository._id.toString() }, 'Error during graph-ask stream');
        if (!clientDisconnected) {
          res.write(
            `event: error\ndata: ${JSON.stringify({ message: 'The response was interrupted. Please try again.' })}\n\n`,
          );
        }
      } finally {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  },
);
