import { Button } from '../ui/button';
import { ApiError } from '../../lib/raw-request';

interface ErrorStateProps {
  error: unknown;
  onRetry: () => void;
}

/**
 * ApiError's message already comes from the backend's own sanitized
 * error responses (never a stack trace - see errors.ts/error-handler.ts
 * on the API side) - safe to show directly. Anything else (a network
 * failure before a response was even received, an unexpected thrown
 * value) gets a generic message instead of whatever a raw JS Error's
 * own .message happens to say, which was never written with an end
 * user in mind.
 */
function toDisplayMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
      <p className="text-sm text-danger">{toDisplayMessage(error)}</p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
