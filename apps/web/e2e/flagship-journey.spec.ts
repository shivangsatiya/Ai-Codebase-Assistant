import { test, expect } from '@playwright/test';
import { registerTestUser, importAndWaitForReady, deleteRepository, type E2ETestUser } from './api-setup';

const TEST_REPO_URL = 'https://github.com/sindresorhus/is-fullwidth-code-point';

let user: E2ETestUser;
let repositoryId: string;

test.beforeAll(async () => {
  user = await registerTestUser();
  repositoryId = await importAndWaitForReady(user, TEST_REPO_URL);
});

test.afterAll(async () => {
  await deleteRepository(user, repositoryId);
});

test.describe('Flagship demo chain', () => {
  test('login -> repository list -> graph -> node inspection -> Pure Graph question', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/workspace/);

    const repoItem = page.getByTestId('repository-list-item').first();
    await expect(repoItem).toBeVisible();
    await repoItem.click();

    await expect(page).toHaveURL(new RegExp(`/workspace/${repositoryId}`));

    const graphNodes = page.getByTestId('graph-node');
    await expect(graphNodes.first()).toBeVisible({ timeout: 20_000 });
    const nodeCountBeforeSelection = await graphNodes.count();
    expect(nodeCountBeforeSelection).toBeGreaterThan(0);

    await graphNodes.first().click();
    const inspector = page.getByTestId('inspector-panel');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText('Certainty')).toBeVisible();
    await expect(inspector.getByText('Source')).toBeVisible();

    const questionInput = page.getByPlaceholder(/why does this depend on redis/i);
    await questionInput.fill('What does this depend on?');
    await page.getByRole('button', { name: /^ask$/i }).click();

    const answerEntry = page.getByTestId('answer-entry').last();
    await expect(answerEntry).toHaveAttribute('data-status', 'complete', { timeout: 15_000 });
    await expect(answerEntry.getByText(/computed directly.*no ai involved/i)).toBeVisible();
    await expect(answerEntry.getByText(/ai-generated/i)).not.toBeVisible();
  });

  test('Hybrid/Semantic question streams a real AI answer, correctly labeled', async ({ page }) => {
    test.skip(!process.env.GROQ_API_KEY, 'Requires a real GROQ_API_KEY to exercise the live AI path - not available in this environment');

    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.goto(`/workspace/${repositoryId}`);

    const graphNodes = page.getByTestId('graph-node');
    await expect(graphNodes.first()).toBeVisible({ timeout: 20_000 });
    await graphNodes.first().click();

    const questionInput = page.getByPlaceholder(/why does this depend on redis/i);
    await questionInput.fill('Explain what this component does.');
    await page.getByRole('button', { name: /^ask$/i }).click();

    const answerEntry = page.getByTestId('answer-entry').last();
    await expect(answerEntry).toHaveAttribute('data-status', 'streaming', { timeout: 15_000 });

    await expect(answerEntry).toHaveAttribute('data-status', 'complete', { timeout: 30_000 });
    await expect(answerEntry.getByText(/ai-generated explanation/i)).toBeVisible();
    await expect(answerEntry.getByText(/computed directly/i)).not.toBeVisible();
  });
});
