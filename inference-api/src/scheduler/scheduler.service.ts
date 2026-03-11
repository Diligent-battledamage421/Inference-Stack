import { Injectable, Logger, HttpException, HttpStatus, OnModuleDestroy } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Router } from '../worker-orchestrator/router';
import { WorkerRegistry } from '../worker-orchestrator/worker-registry';
import { TokenizerService } from '../tokenizer/tokenizer.service';
import { BatchCollector } from './batch-collector';
import {
  Priority,
  QueuedRequest,
  DEFAULT_SCHEDULER_CONFIG,
} from './interfaces';
import { CreateCompletionDto } from '../completions/dto/create-completion.dto';

@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);

  /** Per-user FIFO queues */
  private readonly userQueues = new Map<string, QueuedRequest[]>();
  /** Round-robin index: tracks which user to dequeue from next */
  private userKeys: string[] = [];
  private rrIndex = 0;

  /** Counters */
  private totalQueued = 0;
  private totalQueuedTokens = 0;
  private activeCount = 0;

  /** Active requests (for cancellation) */
  private readonly activeRequests = new Map<string, QueuedRequest>();

  /** Config (mutable for testing) */
  private maxQueueDepth = DEFAULT_SCHEDULER_CONFIG.maxQueueDepth;
  private maxQueuedTokens = DEFAULT_SCHEDULER_CONFIG.maxQueuedTokens;
  private maxConcurrent = Infinity; // no limit by default; workers self-regulate

  /** Aging timer */
  private agingTimer: ReturnType<typeof setInterval> | null = null;
  private agingBoostPerSecond = DEFAULT_SCHEDULER_CONFIG.agingBoostPerSecond;

  constructor(
    private readonly router: Router,
    private readonly registry: WorkerRegistry,
    private readonly tokenizer: TokenizerService,
    private readonly batchCollector: BatchCollector,
  ) {}

  onModuleDestroy(): void {
    if (this.agingTimer) {
      clearInterval(this.agingTimer);
      this.agingTimer = null;
    }
    this.batchCollector.destroy();
  }

  // ── Config setters (for testing) ──────────────────────────

  setMaxQueueDepth(n: number): void {
    this.maxQueueDepth = n;
  }

  setMaxQueuedTokens(n: number): void {
    this.maxQueuedTokens = n;
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Enqueue a non-streaming request. Returns a promise that resolves
   * with the completion result when inference finishes.
   */
  async enqueue(opts: {
    dto: CreateCompletionDto;
    userId: string;
    priority: Priority;
  }): Promise<any> {
    const estimatedTokens = this.tokenizer.estimateTokenCount(opts.dto.prompt);
    this.admissionCheck(estimatedTokens);

    return new Promise<any>((resolve, reject) => {
      const request: QueuedRequest = {
        id: uuidv4(),
        dto: opts.dto,
        userId: opts.userId,
        priority: opts.priority,
        estimatedTokens,
        enqueuedAt: Date.now(),
        effectivePriority: opts.priority,
        state: 'queued',
        resolve,
        reject,
      };

      this.addToQueue(request);
      this.tryDispatch();
    });
  }

  /**
   * Cancel a queued or active request.
   */
  cancel(requestId: string): void {
    // Check queued requests
    for (const [userId, queue] of this.userQueues) {
      const idx = queue.findIndex((r) => r.id === requestId);
      if (idx !== -1) {
        const request = queue.splice(idx, 1)[0];
        this.totalQueued--;
        this.totalQueuedTokens -= request.estimatedTokens;
        if (queue.length === 0) {
          this.userQueues.delete(userId);
          this.refreshUserKeys();
        }
        request.state = 'cancelled';
        request.reject({ error: { message: 'Request cancelled' } });
        return;
      }
    }

    // Check active requests
    const active = this.activeRequests.get(requestId);
    if (active) {
      active.subscription?.unsubscribe();
      active.state = 'cancelled';
      this.finishRequest(active);
      active.reject({ error: { message: 'Request cancelled' } });
    }
  }

  /**
   * Get IDs of all queued requests (for testing/debugging).
   */
  getQueuedRequestIds(): string[] {
    const ids: string[] = [];
    for (const queue of this.userQueues.values()) {
      for (const r of queue) {
        ids.push(r.id);
      }
    }
    return ids;
  }

  /**
   * Get scheduler stats.
   */
  getStats(): { queueDepth: number; totalQueuedTokens: number; activeCount: number } {
    return {
      queueDepth: this.totalQueued,
      totalQueuedTokens: this.totalQueuedTokens,
      activeCount: this.activeCount,
    };
  }

  // ── Internal ──────────────────────────────────────────────

  private admissionCheck(estimatedTokens: number): void {
    if (this.totalQueued >= this.maxQueueDepth) {
      throw new HttpException(
        {
          error: {
            message: 'Too many requests — queue is full',
            type: 'rate_limit',
          },
          retryAfter: this.estimateRetryAfter(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (this.totalQueuedTokens + estimatedTokens > this.maxQueuedTokens) {
      throw new HttpException(
        {
          error: {
            message: 'Token budget exceeded — too many tokens queued',
            type: 'rate_limit',
          },
          retryAfter: this.estimateRetryAfter(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private addToQueue(request: QueuedRequest): void {
    let queue = this.userQueues.get(request.userId);
    if (!queue) {
      queue = [];
      this.userQueues.set(request.userId, queue);
      this.refreshUserKeys();
    }
    queue.push(request);
    this.totalQueued++;
    this.totalQueuedTokens += request.estimatedTokens;
  }

  private refreshUserKeys(): void {
    this.userKeys = Array.from(this.userQueues.keys());
    if (this.rrIndex >= this.userKeys.length) {
      this.rrIndex = 0;
    }
  }

  /**
   * Try to dispatch the next request from the queue.
   * Uses priority-aware round-robin: pick the highest-priority request
   * across users, round-robin within the same priority tier.
   */
  private tryDispatch(): void {
    while (this.activeCount < this.maxConcurrent && this.totalQueued > 0) {
      const request = this.dequeueNext();
      if (!request) break;
      this.batchCollector.submit({
        id: request.id,
        modelId: request.dto.model,
        estimatedTokens: request.estimatedTokens,
        dispatch: () => this.dispatchRequest(request),
      });
    }
  }

  /**
   * Dequeue: pick highest priority, round-robin within tier.
   */
  private dequeueNext(): QueuedRequest | null {
    if (this.userKeys.length === 0) return null;

    // Find the best (lowest) effective priority across all queue heads
    let bestPriority = Infinity;
    for (const key of this.userKeys) {
      const queue = this.userQueues.get(key)!;
      if (queue.length > 0 && queue[0].effectivePriority < bestPriority) {
        bestPriority = queue[0].effectivePriority;
      }
    }

    // Round-robin among users whose head matches the best priority (within 0.5 tolerance for aging)
    const startIdx = this.rrIndex;
    for (let i = 0; i < this.userKeys.length; i++) {
      const idx = (startIdx + i) % this.userKeys.length;
      const key = this.userKeys[idx];
      const queue = this.userQueues.get(key)!;
      if (queue.length > 0 && queue[0].effectivePriority <= bestPriority + 0.5) {
        const request = queue.shift()!;
        this.totalQueued--;
        this.totalQueuedTokens -= request.estimatedTokens;
        if (queue.length === 0) {
          this.userQueues.delete(key);
          this.refreshUserKeys();
        }
        this.rrIndex = (idx + 1) % Math.max(this.userKeys.length, 1);
        return request;
      }
    }

    return null;
  }

  private async dispatchRequest(request: QueuedRequest): Promise<void> {
    request.state = 'routing';
    this.activeCount++;
    this.activeRequests.set(request.id, request);

    try {
      const { worker, workerId } = await this.router.route(request.dto.model);
      request.state = 'active';

      let fullText = '';
      let usage: any = null;
      let finishReason = '';

      // Pass image data if present (for vision models)
      const imageData = request.dto.images?.[0]
        ? Buffer.from(request.dto.images[0], 'base64')
        : undefined;

      const subscription = worker
        .infer({
          request_id: request.id,
          model_id: request.dto.model,
          prompt: request.dto.prompt,
          params: {
            max_tokens: request.dto.max_tokens ?? 50,
            temperature: request.dto.temperature ?? 1.0,
            top_p: request.dto.top_p ?? 1.0,
          },
          ...(imageData && { image_data: imageData, image_mime_type: 'image/png' }),
        })
        .subscribe({
          next: (response) => {
            if (response.chunk) {
              fullText += response.chunk.text || '';
            }
            if (response.complete) {
              finishReason = response.complete.finish_reason;
              usage = response.complete.usage;
            }
            if (response.error) {
              this.finishRequest(request);
              request.reject({
                error: {
                  message: response.error.message,
                  code: response.error.code,
                },
              });
            }
          },
          complete: () => {
            request.state = 'completed';
            this.finishRequest(request);
            request.resolve({
              id: request.id,
              object: 'text_completion',
              created: Math.floor(Date.now() / 1000),
              model: request.dto.model,
              choices: [
                { text: fullText, index: 0, finish_reason: finishReason },
              ],
              usage: {
                prompt_tokens: usage?.prompt_tokens ?? 0,
                completion_tokens: usage?.completion_tokens ?? 0,
                total_tokens:
                  (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
              },
            });
          },
          error: (err) => {
            request.state = 'error';
            this.finishRequest(request);
            request.reject({
              error: {
                message: err.message || 'Inference failed',
                type: 'server_error',
              },
            });
          },
        });

      request.subscription = subscription;
    } catch (err) {
      request.state = 'error';
      this.finishRequest(request);
      request.reject(err);
    }
  }

  private finishRequest(request: QueuedRequest): void {
    if (!this.activeRequests.has(request.id)) return; // already finished (idempotent)
    this.activeRequests.delete(request.id);
    this.activeCount--;
    // Try to dispatch next queued request now that a slot freed up
    this.tryDispatch();
  }

  private estimateRetryAfter(): number {
    // Rough estimate: assume 1s per active request
    return Math.max(1, Math.ceil(this.activeCount));
  }
}
