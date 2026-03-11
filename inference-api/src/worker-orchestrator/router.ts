import { Injectable } from '@nestjs/common';
import { ModelManager } from './model-manager';
import { WorkerRegistry } from './worker-registry';
import { RoutingDecision, WorkerSnapshot } from './interfaces';

@Injectable()
export class Router {
  constructor(
    private readonly modelManager: ModelManager,
    private readonly registry: WorkerRegistry,
  ) {}

  /**
   * Route a request to the best worker for the given model.
   *
   * 1. If model is already loaded → pick least-loaded worker → direct
   * 2. If not → trigger load via ModelManager → load-then-infer
   */
  async route(
    modelId: string,
    quantization?: string,
  ): Promise<RoutingDecision> {
    const readyWorkers = this.modelManager.getWorkersWithModel(modelId);

    if (readyWorkers.length > 0) {
      const best = this.leastLoaded(readyWorkers);
      const worker = this.registry.getWorker(best.workerId)!;
      return { worker, workerId: best.workerId, action: 'direct' };
    }

    const { worker, workerId } = await this.modelManager.ensureModelLoaded(
      modelId,
      quantization,
    );
    return { worker, workerId, action: 'load-then-infer' };
  }

  private leastLoaded(snapshots: WorkerSnapshot[]): WorkerSnapshot {
    return [...snapshots].sort(
      (a, b) =>
        a.activeInferences + a.queuedInferences -
        (b.activeInferences + b.queuedInferences),
    )[0];
  }
}
