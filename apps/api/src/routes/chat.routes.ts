import { Router, type Response, type NextFunction } from 'express';
import { chatOrchestrationService, chatRepo } from '../config/composition-root';
import { validateBody } from '../middleware/validate';
import { chatRateLimiter } from '../middleware/rate-limit';
import { askQuestionSchema, type AskQuestionInput } from './chat.schemas';
import { requireAuth, type AuthenticatedRequest } from '../middleware/require-auth';
import { NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';

export const chatRouter = Router();

chatRouter.post(
  '/:id/messages',
  requireAuth,
  chatRateLimiter,
  validateBody(askQuestionSchema),
  async (req: AuthenticatedRequest & { body: AskQuestionInput }, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!id) {
        throw new NotFoundError('Chat not found');
      }

      const chat = await chatRepo.findById(id);
      if (!chat || chat.userId.toString() !== req.userId) {
        // 404, not 403 — same reasoning as the repository ownership
        // check: confirming a chat id exists at all leaks information
        // to a user who doesn't own it.
        throw new NotFoundError('Chat not found');
      }

      const { message } = req.body;

      /**
       * Why set these headers manually instead of using a library?
       *
       * Server-Sent Events is just a plain HTTP response with a specific
       * content type and a stream of `data: ...\n\n` lines that's never
       * closed until the server ends it - no special protocol upgrade
       * (unlike WebSockets), so no library is actually needed for the
       * basic case. `flushHeaders()` sends these immediately rather than
       * buffering them until the first write, which matters for
       * perceived latency: the client's connection opens right away
       * instead of waiting for the first token.
       */
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();

      // If the client disconnects mid-stream (closed tab, lost
      // connection), stop generating - there's no one listening, and
      // continuing would waste LLM tokens on a response nobody receives.
      let clientDisconnected = false;
      req.on('close', () => {
        clientDisconnected = true;
      });

      try {
        for await (const token of chatOrchestrationService.streamAnswer(id, chat.repositoryId.toString(), message)) {
          if (clientDisconnected) break;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }

        if (!clientDisconnected) {
          res.write(`event: done\ndata: {}\n\n`);
        }
      } catch (err) {
        // Headers are already sent by this point, so the normal JSON
        // error-handler middleware can't run - a mid-stream failure
        // (e.g. the LLM API erroring partway through) has to be
        // reported as an SSE event instead of an HTTP status code.
        logger.error({ err, chatId: id }, 'Error during chat stream');
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
