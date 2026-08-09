import { useAuthStore } from '../stores/auth-store';
import { Button } from '../components/ui/button';

/**
 * Deliberately minimal - the real persistent workspace (sidebar, graph,
 * inspector) is Task 2's job. This exists so Task 1 (auth) can be
 * proven end to end: register or log in, land here, confirm the
 * session persists across a reload, log out, confirm redirect back to
 * login all actually work - without needing the rest of the app built
 * first.
 */
export function WorkspacePage() {
  const { email, logout } = useAuthStore();

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <div className="text-center">
        <p className="mb-2 font-mono text-sm text-fg-muted">Signed in as {email}</p>
        <p className="mb-6 text-fg-subtle">The workspace shell is built in Task 2.</p>
        <Button variant="secondary" onClick={logout}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
