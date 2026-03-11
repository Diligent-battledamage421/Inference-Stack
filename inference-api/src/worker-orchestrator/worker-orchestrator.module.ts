import { Module, OnModuleInit } from '@nestjs/common';
import { WorkerRegistry } from './worker-registry';
import { ModelManager } from './model-manager';
import { Router } from './router';

/**
 * Worker Orchestrator Module
 *
 * Manages GPU workers, model placement, and request routing.
 * Replaces the old GpuWorkerModule (single static client) with
 * dynamic multi-worker support.
 */
@Module({
  providers: [WorkerRegistry, ModelManager, Router],
  exports: [Router, WorkerRegistry, ModelManager],
})
export class WorkerOrchestratorModule implements OnModuleInit {
  constructor(private readonly registry: WorkerRegistry) {}

  async onModuleInit() {
    // Register initial workers
    // TODO: load from config/env instead of hardcoding
    const workers = [
      { id: 'worker-0', url: process.env.GPU_WORKER_0_URL || 'localhost:50051' },
      { id: 'worker-1', url: process.env.GPU_WORKER_1_URL || 'localhost:50052' },
    ];

    for (const w of workers) {
      this.registry.addWorker(w);
    }

    // Initial poll + start periodic polling
    await this.registry.pollAllWorkers();
    this.registry.startPolling(5000);
  }
}
