import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

/**
 * Why test response headers instead of "does the request get blocked"?
 *
 * CORS is enforced by the BROWSER reading the Access-Control-Allow-Origin
 * response header, not by the server refusing to respond - a tool like
 * supertest (or curl, or PowerShell's Invoke-RestMethod) ignores CORS
 * entirely and will always receive the response body. What we CAN and
 * should verify here is that our configuration produces the correct
 * header for an allowed origin, and does not echo back a disallowed one
 * - that's the actual server-side behavior our code controls. Whether a
 * real browser then honors that header is the browser's job, not ours
 * to re-test.
 */
describe('CORS configuration', () => {
  it('echoes back an allowed origin in Access-Control-Allow-Origin', async () => {
    const response = await request(app).get('/health/live').set('Origin', 'http://allowed-origin.test');

    expect(response.headers['access-control-allow-origin']).toBe('http://allowed-origin.test');
  });

  it('does not echo back a disallowed origin', async () => {
    const response = await request(app).get('/health/live').set('Origin', 'http://not-allowed.test');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a request with no Origin header at all (e.g. a server-to-server call) is unaffected', async () => {
    const response = await request(app).get('/health/live');

    expect(response.status).toBe(200);
  });
});
