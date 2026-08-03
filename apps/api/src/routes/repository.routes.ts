import { Router, type Response, type NextFunction } from 'express';
import { repositoryImportService, repositoryRepo, jobRepo, chatOrchestrationService } from '../config/composition-root';
import { validateBody } from '../middleware/validate';
import { importRateLimiter } from '../middleware/rate-limit';
import { importRepositorySchema, type ImportRepositoryInput } from './repository.schemas';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { NotFoundError } from '../utils/errors';

export const repositoryRouter = Router();

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

repositoryRouter.get(
  '/:id',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!id) {
        throw new NotFoundError('Repository not found');
      }

      const repository = await repositoryRepo.findById(id);

      if (!repository) {
        throw new NotFoundError('Repository not found');
      }

      if (repository.ownerId.toString() !== req.userId) {
        // 404, not 403 — confirming a repository id exists at all leaks
        // information to a user who doesn't own it.
        throw new NotFoundError('Repository not found');
      }

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

repositoryRouter.post(
  '/:id/chats',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!id) {
        throw new NotFoundError('Repository not found');
      }

      const repository = await repositoryRepo.findById(id);
      if (!repository || repository.ownerId.toString() !== req.userId) {
        throw new NotFoundError('Repository not found');
      }

      if (repository.status !== 'ready') {
        res.status(409).json({
          error: {
            code: 'REPOSITORY_NOT_READY',
            message: `Repository is not ready for chat yet (current status: ${repository.status})`,
          },
        });
        return;
      }

      const chatId = await chatOrchestrationService.startChat(id, req.userId as string);

      res.status(201).json({ chatId, repositoryId: id });
    } catch (err) {
      next(err);
    }
  },
);
