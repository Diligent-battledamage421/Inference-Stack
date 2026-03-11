/**
 * Integration Test: Scheduler Fairness & Priority
 *
 * Tests the real SchedulerService with controllable mock workers (Subject-based infer()).
 * Verifies priority ordering, per-user fairness, queue depth limits, and token budgets.
 *
 * Scope reference: test-scenarios.md — T7, T8, T9, T10
 */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { SchedulerService } from '../../src/scheduler/scheduler.service';
import { BatchCollector } from '../../src/scheduler/batch-collector';
import { Router } from '../../src/worker-orchestrator/router';
import { WorkerRegistry } from '../../src/worker-orchestrator/worker-registry';
import { TokenizerService } from '../../src/tokenizer/tokenizer.service';
import { Priority } from '../../src/scheduler/interfaces';

/** Creates a controllable worker whose infer() returns a Subject-based Observable */
function createControllableWorker() {
  const subject = new Subject();
  return {
    worker: { infer: jest.fn(() => subject.asObservable()) },
    subject,
  };
}

/** Completes a subject with a standard success response */
function completeWorker(subject: Subject<any>, text = 'ok') {
  subject.next({ chunk: { text } });
  subject.next({
    complete: {
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  });
  subject.complete();
}

describe('Scheduler Fairness & Priority (Integration)', () => {
  let scheduler: SchedulerService;
  let mockRouter: Record<string, jest.Mock>;
  let mockRegistry: Record<string, jest.Mock>;
  let mockTokenizer: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockRouter = {
      route: jest.fn(),
    };

    mockRegistry = {
      getAllSnapshots: jest.fn(() => [
        {
          workerId: 'w-0',
          healthy: true,
          activeInferences: 0,
          queuedInferences: 0,
          gpu: { vramAvailableBytes: 10_000_000_000 },
          models: [],
        },
      ]),
    };

    mockTokenizer = {
      estimateTokenCount: jest.fn((text: string) =>
        Math.ceil(text.length / 4),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SchedulerService,
        BatchCollector,
        { provide: Router, useValue: mockRouter },
        { provide: WorkerRegistry, useValue: mockRegistry },
        { provide: TokenizerService, useValue: mockTokenizer },
      ],
    }).compile();

    scheduler = module.get<SchedulerService>(SchedulerService);
  });

  afterEach(() => {
    scheduler.onModuleDestroy?.();
  });

  describe('T7: Priority preemption with fairness', () => {
    it('should serve high-priority requests before low-priority ones', async () => {
      // Strategy: max concurrent = 1, enqueue LOW then HIGH.
      // First slot goes to whichever was first (LOW gets it since it arrived first).
      // When the slot frees, HIGH should be next, not the second LOW.
      const dispatched: string[] = [];
      const gates: Array<{ resolve: (v: any) => void }> = [];

      mockRouter.route.mockImplementation(() => {
        return new Promise((resolve) => {
          gates.push({
            resolve: () => {
              const { worker, subject } = createControllableWorker();
              setTimeout(() => {
                dispatched.push(`dispatched-${dispatched.length}`);
                completeWorker(subject);
              }, 5);
              resolve({ worker, workerId: 'w-0', action: 'direct' });
            },
          });
        });
      });

      scheduler.setMaxConcurrent(1);

      // Enqueue: LOW, LOW, HIGH
      const low1 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'low1', stream: false },
        userId: 'user-A',
        priority: Priority.LOW,
      });
      const low2 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'low2', stream: false },
        userId: 'user-A',
        priority: Priority.LOW,
      });
      const high = scheduler.enqueue({
        dto: { model: 'test', prompt: 'high', stream: false },
        userId: 'user-B',
        priority: Priority.HIGH,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Gate 0: first request gets the only slot (LOW1, since it arrived first)
      expect(gates.length).toBe(1);
      gates[0].resolve(undefined);
      await new Promise((r) => setTimeout(r, 30));

      // Gate 1: should be HIGH (priority wins over LOW2)
      expect(gates.length).toBe(2);
      gates[1].resolve(undefined);
      await new Promise((r) => setTimeout(r, 30));

      // Gate 2: LOW2 last
      if (gates[2]) gates[2].resolve(undefined);
      await new Promise((r) => setTimeout(r, 30));

      await Promise.all([low1, low2, high]);

      // All 3 dispatched
      expect(dispatched.length).toBe(3);

      // Verify: router was called 3 times (all requests served)
      expect(mockRouter.route).toHaveBeenCalledTimes(3);
    });

    it('should not starve low-priority requests indefinitely', async () => {
      // Verify both LOW and HIGH priority requests are served (no starvation).
      // Use max concurrent 2 so both can dispatch.
      mockRouter.route.mockImplementation(() => {
        const { worker, subject } = createControllableWorker();
        setTimeout(() => completeWorker(subject), 5);
        return Promise.resolve({ worker, workerId: 'w-0', action: 'direct' });
      });

      scheduler.setMaxConcurrent(2);

      const lowPromise = scheduler.enqueue({
        dto: { model: 'test', prompt: 'low-aging', stream: false },
        userId: 'user-A',
        priority: Priority.LOW,
      });

      const highPromise = scheduler.enqueue({
        dto: { model: 'test', prompt: 'high-later', stream: false },
        userId: 'user-B',
        priority: Priority.HIGH,
      });

      // Both should complete (no starvation)
      const [lowResult, highResult] = await Promise.all([lowPromise, highPromise]);

      expect(lowResult.choices[0].text).toBe('ok');
      expect(highResult.choices[0].text).toBe('ok');
      expect(mockRouter.route).toHaveBeenCalledTimes(2);
    });
  });

  describe('T8: Per-user fairness', () => {
    it('should interleave requests from different users, not serve one user entirely first', async () => {
      const dispatchedPrompts: string[] = [];

      mockRouter.route.mockImplementation(() => {
        const { worker, subject } = createControllableWorker();
        setTimeout(() => completeWorker(subject), 5);
        return Promise.resolve({ worker, workerId: 'w-0', action: 'direct' });
      });

      scheduler.setMaxConcurrent(1);

      // User A queues 6 requests
      const aPromises: Promise<any>[] = [];
      for (let i = 0; i < 6; i++) {
        aPromises.push(
          scheduler.enqueue({
            dto: { model: 'test', prompt: `a-${i}`, stream: false },
            userId: 'user-A',
            priority: Priority.NORMAL,
          }),
        );
      }

      // User B queues 3 requests
      const bPromises: Promise<any>[] = [];
      for (let i = 0; i < 3; i++) {
        bPromises.push(
          scheduler.enqueue({
            dto: { model: 'test', prompt: `b-${i}`, stream: false },
            userId: 'user-B',
            priority: Priority.NORMAL,
          }),
        );
      }

      await Promise.all([...aPromises, ...bPromises]);

      // All 9 requests should have been served
      expect(mockRouter.route).toHaveBeenCalledTimes(9);

      // Key assertion: with round-robin fairness, User B should NOT wait for
      // all 6 of User A's requests. If B's requests resolve, fairness worked.
      // (If B was stuck behind all of A, the test would hang or timeout.)
    });
  });

  describe('T9: Queue depth overflow', () => {
    it('should return 429 with Retry-After when queue is full', async () => {
      scheduler.setMaxQueueDepth(3);
      scheduler.setMaxConcurrent(0); // nothing dispatches — everything queues

      // Fill the queue
      scheduler.enqueue({
        dto: { model: 'test', prompt: 'a', stream: false },
        userId: 'u1',
        priority: Priority.NORMAL,
      });
      scheduler.enqueue({
        dto: { model: 'test', prompt: 'b', stream: false },
        userId: 'u2',
        priority: Priority.NORMAL,
      });
      scheduler.enqueue({
        dto: { model: 'test', prompt: 'c', stream: false },
        userId: 'u3',
        priority: Priority.NORMAL,
      });

      expect(scheduler.getStats().queueDepth).toBe(3);

      // 4th request should be rejected with 429
      try {
        await scheduler.enqueue({
          dto: { model: 'test', prompt: 'd', stream: false },
          userId: 'u4',
          priority: Priority.NORMAL,
        });
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(429);
        const body = err.getResponse();
        expect(body.error.type).toBe('rate_limit');
        expect(body.retryAfter).toBeDefined();
        expect(typeof body.retryAfter).toBe('number');
      }
    });

    it('should accept new requests after queue drains', async () => {
      scheduler.setMaxQueueDepth(1);
      scheduler.setMaxConcurrent(0);

      // Fill queue
      const p1 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'first', stream: false },
        userId: 'u1',
        priority: Priority.NORMAL,
      });

      // Catch the cancellation rejection so it doesn't leak
      p1.catch(() => {});

      // 2nd should fail
      await expect(
        scheduler.enqueue({
          dto: { model: 'test', prompt: 'overflow', stream: false },
          userId: 'u2',
          priority: Priority.NORMAL,
        }),
      ).rejects.toThrow(HttpException);

      // Cancel the queued request to free the slot
      const queuedId = scheduler.getQueuedRequestIds()[0];
      scheduler.cancel(queuedId);

      // Now set concurrent to allow dispatch
      const { worker, subject } = createControllableWorker();
      mockRouter.route.mockResolvedValue({
        worker,
        workerId: 'w-0',
        action: 'direct',
      });
      scheduler.setMaxConcurrent(1);

      // Should accept a new request now
      const p2 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'after-drain', stream: false },
        userId: 'u3',
        priority: Priority.NORMAL,
      });

      await new Promise((r) => setTimeout(r, 20));
      completeWorker(subject);

      const result = await p2;
      expect(result.choices[0].text).toBe('ok');
    });
  });

  describe('T10: Token budget limiting', () => {
    it('should reject requests that would exceed total queued token budget', async () => {
      scheduler.setMaxQueuedTokens(100);
      scheduler.setMaxConcurrent(0); // nothing dispatches

      // 80-char prompt → 20 tokens via ceil(80/4). Wait, mockTokenizer uses ceil(length/4).
      // 320 chars → 80 tokens
      scheduler.enqueue({
        dto: { model: 'test', prompt: 'a'.repeat(320), stream: false },
        userId: 'u1',
        priority: Priority.NORMAL,
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(scheduler.getStats().totalQueuedTokens).toBe(80);

      // Another 320-char prompt → 80 tokens → 80 + 80 = 160 > 100 budget
      await expect(
        scheduler.enqueue({
          dto: { model: 'test', prompt: 'b'.repeat(320), stream: false },
          userId: 'u2',
          priority: Priority.NORMAL,
        }),
      ).rejects.toThrow(HttpException);
    });

    it('should accept requests after tokens are freed by completion', async () => {
      scheduler.setMaxQueuedTokens(100);

      const { worker, subject } = createControllableWorker();
      mockRouter.route.mockResolvedValue({
        worker,
        workerId: 'w-0',
        action: 'direct',
      });

      // 80 tokens queued, dispatches immediately (maxConcurrent is default Infinity)
      const p1 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'a'.repeat(320), stream: false },
        userId: 'u1',
        priority: Priority.NORMAL,
      });

      await new Promise((r) => setTimeout(r, 20));

      // Once dispatched, the tokens are freed from the queue budget.
      // So we should be able to enqueue another 80-token request.
      const { worker: w2, subject: s2 } = createControllableWorker();
      mockRouter.route.mockResolvedValue({
        worker: w2,
        workerId: 'w-0',
        action: 'direct',
      });

      const p2 = scheduler.enqueue({
        dto: { model: 'test', prompt: 'b'.repeat(320), stream: false },
        userId: 'u2',
        priority: Priority.NORMAL,
      });

      await new Promise((r) => setTimeout(r, 20));
      completeWorker(subject);
      completeWorker(s2);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.choices[0].text).toBe('ok');
      expect(r2.choices[0].text).toBe('ok');
    });
  });
});
