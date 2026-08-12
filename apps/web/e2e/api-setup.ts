const API_BASE_URL = process.env.E2E_API_BASE_URL ?? 'http://localhost:4000';
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_INTERVAL_MS = 3_000;

export interface E2ETestUser {
  email: string;
  password: string;
  accessToken: string;
}

/**
 * Setup helpers using direct API calls, not the UI - deliberately.
 * "Use the real application behavior... do not mock the entire
 * application" is about the actual test flow (login through the real
 * form, real graph rendering, a real streamed answer) - it does not
 * require account creation and repository import, which are not part
 * of the stated flagship demo chain, to also go through the UI. This
 * is the same "API for setup, UI for the actual test" split already
 * used by every other test-adjacent tool in this project.
 */
export async function registerTestUser(): Promise<E2ETestUser> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = 'E2ETestPass123';

  const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new Error(`Failed to register E2E test user: ${response.status} ${await response.text()}`);
  }

  const body = await response.json();
  return { email, password, accessToken: body.accessToken };
}

export async function importAndWaitForReady(user: E2ETestUser, githubUrl: string): Promise<string> {
  const importResponse = await fetch(`${API_BASE_URL}/api/repositories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: JSON.stringify({ githubUrl }),
  });

  if (!importResponse.ok) {
    throw new Error(`Failed to import ${githubUrl}: ${importResponse.status} ${await importResponse.text()}`);
  }

  const { repositoryId } = await importResponse.json();

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusResponse = await fetch(`${API_BASE_URL}/api/repositories/${repositoryId}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const status = await statusResponse.json();

    if (status.status === 'ready') {
      // Repository status reaching 'ready' does not guarantee the
      // knowledge graph also reached 'ready' - the same real, verified
      // finding from Task 2's smoke test (confirmed directly in
      // repository-import.service.ts: graph generation is awaited and
      // can fail non-fatally before the repository itself is marked
      // ready). Checked explicitly here too, not assumed.
      const graphResponse = await fetch(`${API_BASE_URL}/api/repositories/${repositoryId}/graph`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      const graph = await graphResponse.json();
      if (graph.status !== 'ready') {
        throw new Error(`Repository reached 'ready' but its graph did not (graph status: ${graph.status})`);
      }
      return repositoryId;
    }

    if (status.status === 'failed') {
      throw new Error(`Repository import failed: ${status.errorMessage ?? 'unknown reason'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }

  throw new Error(`Repository did not become ready within ${READY_TIMEOUT_MS}ms`);
}

export async function deleteRepository(user: E2ETestUser, repositoryId: string): Promise<void> {
  await fetch(`${API_BASE_URL}/api/repositories/${repositoryId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${user.accessToken}` },
  }).catch(() => undefined);
}
