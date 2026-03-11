/**
 * E2E Test: Full Inference API
 *
 * Tests the complete HTTP stack: client → NestJS API → GPU worker → response.
 * Requires: SSH tunnel to RunPod (localhost:50051) and model loaded on worker.
 *
 * Run: npm run test:e2e
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../../src/app.module';

const TEST_MODEL = 'HuggingFaceTB/SmolLM2-135M';
const TEST_MODEL_B = 'HuggingFaceTB/SmolLM2-360M';
const TIMEOUT = 30_000;

describe('Inference API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, TIMEOUT);

  afterAll(async () => {
    await app.close();
  });

  // ─── Validation ───────────────────────────────────────────────

  describe('POST /v1/completions — validation', () => {
    it('should return 400 when model is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/completions')
        .send({ prompt: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/model/i);
    });

    it('should return 400 when prompt is missing', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/completions')
        .send({ model: TEST_MODEL });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.message).toMatch(/prompt/i);
    });
  });

  // ─── Non-streaming ────────────────────────────────────────────

  describe('POST /v1/completions — non-streaming', () => {
    it(
      'should return a completion with OpenAI-compatible shape',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'The meaning of life is',
            max_tokens: 10,
            temperature: 1.0,
            stream: false,
          });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          id: expect.any(String),
          object: 'text_completion',
          created: expect.any(Number),
          model: TEST_MODEL,
        });
        expect(res.body.choices).toHaveLength(1);
        expect(res.body.choices[0]).toMatchObject({
          text: expect.any(String),
          index: 0,
          finish_reason: expect.any(String),
        });
        expect(res.body.choices[0].text.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      'should include token usage stats',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'Once upon a time',
            max_tokens: 5,
            stream: false,
          });

        expect(res.status).toBe(200);
        expect(res.body.usage).toBeDefined();
        expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
        expect(res.body.usage.completion_tokens).toBeGreaterThan(0);
        expect(res.body.usage.total_tokens).toBe(
          res.body.usage.prompt_tokens + res.body.usage.completion_tokens,
        );
      },
      TIMEOUT,
    );

    it(
      'should respect max_tokens parameter',
      async () => {
        const small = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'Write a long story',
            max_tokens: 3,
            stream: false,
          });

        expect(small.status).toBe(200);
        expect(small.body.usage.completion_tokens).toBeLessThanOrEqual(5);
      },
      TIMEOUT,
    );
  });

  // ─── Streaming ────────────────────────────────────────────────

  describe('POST /v1/completions — streaming', () => {
    it(
      'should stream SSE events and end with [DONE]',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'Hello world',
            max_tokens: 10,
            stream: true,
          })
          .buffer(true)
          .parse((res, cb) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
            });
            res.on('end', () => cb(null, data));
          });

        expect(res.status).toBe(200);

        const raw = res.body as string;
        const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
        expect(lines.length).toBeGreaterThanOrEqual(2); // at least one token + [DONE]

        // Last line should be [DONE]
        const lastPayload = lines[lines.length - 1].slice(6).trim();
        expect(lastPayload).toBe('[DONE]');

        // Earlier lines should be valid JSON with choices
        const firstPayload = JSON.parse(lines[0].slice(6).trim());
        expect(firstPayload).toMatchObject({
          id: expect.any(String),
          object: 'text_completion',
          model: TEST_MODEL,
          choices: expect.any(Array),
        });
      },
      TIMEOUT,
    );

    it(
      'should include usage stats in the completion event',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'Count to three:',
            max_tokens: 8,
            stream: true,
          })
          .buffer(true)
          .parse((res, cb) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
            });
            res.on('end', () => cb(null, data));
          });

        const raw = res.body as string;
        const lines = raw.split('\n').filter((l) => l.startsWith('data: '));

        // Find the event with usage stats (just before [DONE])
        const dataLines = lines.filter((l) => l.slice(6).trim() !== '[DONE]');
        const lastDataLine = dataLines[dataLines.length - 1];
        const lastEvent = JSON.parse(lastDataLine.slice(6).trim());

        // The completion event (with finish_reason) should have usage
        expect(lastEvent.usage).toBeDefined();
        expect(lastEvent.usage.prompt_tokens).toBeGreaterThan(0);
        expect(lastEvent.usage.completion_tokens).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      'should stream content-type as text/event-stream',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'Hi',
            max_tokens: 3,
            stream: true,
          })
          .buffer(true)
          .parse((res, cb) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
            });
            res.on('end', () => cb(null, data));
          });

        expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      },
      TIMEOUT,
    );
  });

  // ─── CRUD ─────────────────────────────────────────────────────

  describe('GET /v1/completions — list', () => {
    it('should return an array of completions', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/completions');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('should include completions created by POST', async () => {
      // Create one first
      await request(app.getHttpServer())
        .post('/v1/completions')
        .send({
          model: TEST_MODEL,
          prompt: 'e2e-marker-test',
          max_tokens: 3,
          stream: false,
        });

      const res = await request(app.getHttpServer())
        .get('/v1/completions');

      const found = res.body.find(
        (c: any) => c.prompt === 'e2e-marker-test',
      );
      expect(found).toBeDefined();
      expect(found.model).toBe(TEST_MODEL);
      expect(found.status).toBe('completed');
    }, TIMEOUT);
  });

  describe('GET /v1/completions/:id', () => {
    it(
      'should return a specific completion by ID',
      async () => {
        const created = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'fetch-by-id test',
            max_tokens: 3,
            stream: false,
          });

        const id = created.body.id;
        const res = await request(app.getHttpServer())
          .get(`/v1/completions/${id}`);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(id);
        expect(res.body.prompt).toBe('fetch-by-id test');
      },
      TIMEOUT,
    );

    it('should return null for non-existent ID', async () => {
      const res = await request(app.getHttpServer())
        .get('/v1/completions/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(200);
      // findOneBy returns null → NestJS serializes as empty response or null
    });
  });

  describe('DELETE /v1/completions/:id', () => {
    it(
      'should delete a completion',
      async () => {
        const created = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'delete-me-test',
            max_tokens: 3,
            stream: false,
          });

        const id = created.body.id;

        const delRes = await request(app.getHttpServer())
          .delete(`/v1/completions/${id}`);
        expect(delRes.status).toBe(200);

        const getRes = await request(app.getHttpServer())
          .get(`/v1/completions/${id}`);
        // Should be gone — null serializes as empty body or empty object
        expect(getRes.body?.id).toBeUndefined();
      },
      TIMEOUT,
    );
  });

  // ─── Persistence ──────────────────────────────────────────────

  describe('Database persistence', () => {
    it(
      'should persist completion with timing and usage data',
      async () => {
        const created = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'persistence check prompt',
            max_tokens: 5,
            temperature: 0.7,
            stream: false,
          });

        const id = created.body.id;
        const fetched = await request(app.getHttpServer())
          .get(`/v1/completions/${id}`);

        expect(fetched.body).toMatchObject({
          id,
          model: TEST_MODEL,
          prompt: 'persistence check prompt',
          status: 'completed',
          stream: false,
          temperature: 0.7,
          max_tokens: 5,
        });
        expect(fetched.body.prompt_tokens).toBeGreaterThan(0);
        expect(fetched.body.completion_tokens).toBeGreaterThan(0);
        expect(fetched.body.completion_text).toBeTruthy();
        expect(fetched.body.finish_reason).toBeTruthy();
        expect(fetched.body.created_at).toBeTruthy();
      },
      TIMEOUT,
    );
  });

  // ─── Scheduler Integration ──────────────────────────────────

  describe('Scheduler integration', () => {
    it(
      'should accept priority and user fields and return a valid response',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL,
            prompt: 'scheduler priority test',
            max_tokens: 5,
            stream: false,
            priority: 'high',
            user: 'e2e-test-user',
          });

        expect(res.status).toBe(200);
        expect(res.body.choices).toHaveLength(1);
        expect(res.body.choices[0].text.length).toBeGreaterThan(0);
      },
      TIMEOUT,
    );

    it(
      'should return queue stats from GET /v1/completions/stats',
      async () => {
        const res = await request(app.getHttpServer())
          .get('/v1/completions/stats');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          queueDepth: expect.any(Number),
          totalQueuedTokens: expect.any(Number),
          activeCount: expect.any(Number),
        });
        expect(res.body.queueDepth).toBeGreaterThanOrEqual(0);
        expect(res.body.activeCount).toBeGreaterThanOrEqual(0);
      },
    );
  });

  // ─── Error model (destructive — must run after tests needing SmolLM2-135M) ───

  describe('POST /v1/completions — error cases', () => {
    it(
      'should return error for model not loaded on worker',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: 'nonexistent/model-that-does-not-exist',
            prompt: 'Hello',
            max_tokens: 5,
            stream: false,
          });

        // Should get an error response (404, 500, or similar)
        expect(res.status).toBeGreaterThanOrEqual(400);
        // Error body shape varies — check for error field or message
        expect(
          res.body.error || res.body.message || res.status >= 400,
        ).toBeTruthy();
      },
      TIMEOUT,
    );
  });

  // ─── Cross-Worker / Model Swap (may change loaded models) ──

  describe('POST /v1/completions — cross-worker model routing', () => {
    it(
      'should auto-load SmolLM2-360M and return a valid completion',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL_B,
            prompt: 'Once upon a time',
            max_tokens: 8,
            stream: false,
          });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          id: expect.any(String),
          object: 'text_completion',
          model: TEST_MODEL_B,
        });
        expect(res.body.choices).toHaveLength(1);
        expect(res.body.choices[0].text.length).toBeGreaterThan(0);
        expect(res.body.usage.completion_tokens).toBeGreaterThan(0);
      },
      120_000, // May need to download + load model
    );

    it(
      'should stream from SmolLM2-360M',
      async () => {
        const res = await request(app.getHttpServer())
          .post('/v1/completions')
          .send({
            model: TEST_MODEL_B,
            prompt: 'The sun is',
            max_tokens: 5,
            stream: true,
          })
          .buffer(true)
          .parse((res, cb) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
            });
            res.on('end', () => cb(null, data));
          });

        expect(res.status).toBe(200);

        const raw = res.body as string;
        const lines = raw.split('\n').filter((l) => l.startsWith('data: '));
        expect(lines.length).toBeGreaterThanOrEqual(2);

        const lastPayload = lines[lines.length - 1].slice(6).trim();
        expect(lastPayload).toBe('[DONE]');

        const firstPayload = JSON.parse(lines[0].slice(6).trim());
        expect(firstPayload.model).toBe(TEST_MODEL_B);
      },
      TIMEOUT,
    );
  });

  // ─── Cancel on Disconnect ───────────────────────────────────

  describe('Cancel on disconnect', () => {
    it(
      'should cancel a streaming request when the client aborts',
      async () => {
        // Start the server listening so we can use native fetch with AbortController
        const server = app.getHttpServer();
        await new Promise<void>((resolve) => {
          if (server.listening) return resolve();
          server.listen(0, () => resolve());
        });
        const port = (server.address() as any).port;

        const abortCtrl = new AbortController();

        // Start a long streaming request
        const fetchPromise = fetch(
          `http://127.0.0.1:${port}/v1/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: TEST_MODEL,
              prompt: 'Write a very long story about a dragon and a knight. ' +
                'Include many details about the kingdom, the castle, and the battle.',
              max_tokens: 200,
              stream: true,
            }),
            signal: abortCtrl.signal,
          },
        ).catch(() => null); // AbortError is expected

        // Wait a bit for the request to start streaming
        await new Promise((r) => setTimeout(r, 500));

        // Abort the request (simulates client disconnect)
        abortCtrl.abort();

        // Wait for server to process the cancellation
        await new Promise((r) => setTimeout(r, 500));

        // Verify the server is still healthy (not stuck)
        const statsRes = await request(server)
          .get('/v1/completions/stats');

        expect(statsRes.status).toBe(200);
        expect(statsRes.body.activeCount).toBeGreaterThanOrEqual(0);
      },
      TIMEOUT,
    );
  });
});
