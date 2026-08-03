import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('POST /api/auth/register', () => {
  it('creates a new account and returns tokens', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'newuser@example.com', password: 'Password123' });

    expect(response.status).toBe(201);
    expect(response.body.email).toBe('newuser@example.com');
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects a weak password with a 422 and a clear message', async () => {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ email: 'weakpass@example.com', password: 'short' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dupe@example.com', password: 'Password123' });

    const second = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dupe@example.com', password: 'Password123' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'logintest@example.com', password: 'Password123' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'logintest@example.com', password: 'Password123' });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
  });

  it('rejects an incorrect password with 401 and no detail about which field was wrong', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'wrongpwtest@example.com', password: 'Password123' });

    const response = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrongpwtest@example.com', password: 'WrongPassword1' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/auth/refresh', () => {
  it('issues a new token pair for a valid refresh token', async () => {
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({ email: 'refreshtest@example.com', password: 'Password123' });

    const response = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: registerResponse.body.refreshToken });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).not.toBe(registerResponse.body.refreshToken);
  });

  it('rejects a refresh token that has already been used once (rotation)', async () => {
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({ email: 'refreshreuse@example.com', password: 'Password123' });

    await request(app).post('/api/auth/refresh').send({ refreshToken: registerResponse.body.refreshToken });

    const reused = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: registerResponse.body.refreshToken });

    expect(reused.status).toBe(401);
    expect(reused.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a garbage refresh token with a 401, not a 500', async () => {
    const response = await request(app).post('/api/auth/refresh').send({ refreshToken: 'not-a-real-token' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a missing refreshToken with a 422 validation error', async () => {
    const response = await request(app).post('/api/auth/refresh').send({});

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the refresh token, returning 204', async () => {
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({ email: 'logouttest@example.com', password: 'Password123' });

    const response = await request(app)
      .post('/api/auth/logout')
      .send({ refreshToken: registerResponse.body.refreshToken });

    expect(response.status).toBe(204);
  });

  it('a logged-out refresh token can no longer be used to refresh', async () => {
    const registerResponse = await request(app)
      .post('/api/auth/register')
      .send({ email: 'logoutthenrefresh@example.com', password: 'Password123' });

    await request(app).post('/api/auth/logout').send({ refreshToken: registerResponse.body.refreshToken });

    const refreshAttempt = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: registerResponse.body.refreshToken });

    expect(refreshAttempt.status).toBe(401);
  });
});

describe('GET /api/repositories/:id', () => {
  it('requires authentication', async () => {
    const response = await request(app).get('/api/repositories/000000000000000000000000');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/repositories/:id/chats', () => {
  it('requires authentication', async () => {
    const response = await request(app).post('/api/repositories/000000000000000000000000/chats');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/chats/:id/messages', () => {
  it('requires authentication', async () => {
    const response = await request(app)
      .post('/api/chats/000000000000000000000000/messages')
      .send({ message: 'a question' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});
