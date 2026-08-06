import { Router, type Response, type NextFunction } from 'express';
import {
  repositoryImportService,
  repositoryRepo,
  jobRepo,
  chatOrchestrationService,
  repositoryManagementService,
} from '../config/composition-root';
import { validateBody } from '../middleware/validate';
import { importRateLimiter } from '../middleware/rate-limit';
import { importRepositorySchema, type ImportRepositoryInput } from './repository.schemas';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { NotFoundError } from '../utils/errors';
import type { RepositoryDocument } from '../models/repository.model';

export const repositoryRouter = Router();

/**
 * Extracted here because this task adds a THIRD handler needing this
 * exact pattern (GET /:id and POST /:id/chats already had it,
 * independently duplicated) - a DRY opportunity the Milestone 1.5 audit
 * flagged but didn't fix at the time, worth closing now rather than
 * writing a fourth copy.
 *
 * 404, not 403, on a mismatched owner - confirming a repository id
 * exists at all leaks information to a user who doesn't own it.
 */
export async function getOwnedRepositoryOrThrow(id: string | undefined, userId: string): Promise<RepositoryDocument> {
  if (!id) {
    throw new NotFoundError('Repository not found');
  }

  const repository = await repositoryRepo.findById(id);
  if (!repository || repository.ownerId.toString() !== userId) {
    throw new NotFoundError('Repository not found');
  }

  return repository;
}

repositoryRouter.post(
  '/',
  requireAuth,
  importRateLimiter,
  validateBody(importRepositorySchema),
  async (req: AuthenticatedRequest & { body: ImportRepositoryInput }, res: Response, next: NextFunction) => {
    try {
      // requireAuth guarantees req.userId is set before this handler runs.
      const ownerId = req.userId as string;
      const { githubUrl } = req.body;

      const { repository, job } = await repositoryImportService.startImport(ownerId, githubUrl);

      res.status(202).json({
        repositoryId: repository._id.toString(),
        status: repository.status,
        jobId: job._id.toString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

repositoryRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const repositories = await repositoryManagementService.listForUser(req.userId as string);

    res.status(200).json({
      repositories: repositories.map((repo) => ({
        repositoryId: repo._id.toString(),
        githubUrl: repo.githubUrl,
        status: repo.status,
        isPrivate: repo.isPrivate,
        fileCount: repo.fileCount,
      })),
    });
  } catch (err) {
    next(err);
  }
});

repositoryRouter.get(
  '/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      const job = await jobRepo.findByRepositoryId(repository._id.toString());

      res.status(200).json({
        repositoryId: repository._id.toString(),
        githubUrl: repository.githubUrl,
        status: repository.status,
        fileCount: repository.fileCount,
        errorMessage: repository.errorMessage,
        job: job
          ? { stage: job.stage, progress: job.progress, error: job.error }
          : null,
      });
    } catch (err) {
      next(err);
    }
  },
);

repositoryRouter.delete(
  '/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      // getOwnedRepositoryOrThrow both validates the id format/ownership
      // AND gives repositoryManagementService.deleteRepository its own
      // internal findById+ownership check "for free" the second time -
      // a small, deliberate redundancy: the service's own check is what
      // makes it correct and testable in isolation (its own tests inject
      // fakes and never touch this route at all), while the route's
      // check is what returns the right 404 before ever calling a
      // service method that would otherwise redundantly do the same
      // check purely for a slightly different caller.
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);
      await repositoryManagementService.deleteRepository(repository._id.toString(), req.userId as string);

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

repositoryRouter.post(
  '/:id/chats',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const repository = await getOwnedRepositoryOrThrow(req.params.id, req.userId as string);

      if (repository.status !== 'ready') {
        res.status(409).json({
          error: {
            code: 'REPOSITORY_NOT_READY',
            message: `Repository is not ready for chat yet (current status: ${repository.status})`,
          },
        });
        return;
      }

      const chatId = await chatOrchestrationService.startChat(repository._id.toString(), req.userId as string);

      res.status(201).json({ chatId, repositoryId: repository._id.toString() });
    } catch (err) {
      next(err);
    }
  },
);
