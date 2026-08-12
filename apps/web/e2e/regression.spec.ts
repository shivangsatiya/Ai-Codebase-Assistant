import { test, expect } from '@playwright/test';

test.describe('Critical regressions', () => {
  test('unauthenticated access to the workspace redirects to login', async ({ page }) => {
    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a graph loading failure shows a real error state, not a blank screen or a crash', async ({ page, context }) => {
    await context.route('**/api/repositories/*/graph', (route) => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Simulated failure for E2E testing' } }),
      });
    });

    await context.route('**/api/repositories', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            repositories: [
              {
                repositoryId: 'fake-repo-id',
                githubUrl: 'https://github.com/test/repo',
                status: 'ready',
                isPrivate: false,
                fileCount: 5,
              },
            ],
          }),
        });
      } else {
        route.continue();
      }
    });
    await context.route('**/api/repositories/fake-repo-id', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repositoryId: 'fake-repo-id',
          githubUrl: 'https://github.com/test/repo',
          status: 'ready',
          fileCount: 5,
          errorMessage: null,
          job: null,
        }),
      });
    });

    await page.goto('/login');

    const email = `e2e-fail-${Date.now()}@example.com`;
    const registerResponse = await page.request.post('http://localhost:4000/api/auth/register', {
      data: { email, password: 'E2ETestPass123' },
    });
    expect(registerResponse.ok()).toBe(true);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('E2ETestPass123');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/workspace/);

    await page.getByTestId('repository-list-item').first().click();

    await expect(page.getByText('Simulated failure for E2E testing')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });
});
