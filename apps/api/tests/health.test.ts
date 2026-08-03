import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app';
import { getTestMongoUri } from './setup';

const app = createApp();

describe('GET /health/live', () => {
  it('always returns 200 - it checks the process is alive, not any dependency', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when MongoDB is connected (the normal case)', async () => {
    // The shared test database connection (set up once for the whole
    // file via tests/setup.ts) is already live by the time this test
    // runs - no special setup needed to prove the "everything is fine"
    // path.
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
  });

  it('returns 503 when MongoDB is disconnected - proving the check reflects real state, not just returning 200 unconditionally', async () => {
    await mongoose.disconnect();

    try {
      const response = await request(app).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body.status).toBe('not ready');
    } finally {
      // Reconnect regardless of the assertion outcome above, so this
      // deliberate disconnect doesn't break every other test in this
      // file that runs after it.
      await mongoose.connect(getTestMongoUri());
    }
  });
});
