import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { firstValueFrom } from 'rxjs';
import { GpuWorkerService } from '../gpu-worker/gpu-worker.service';
import {
  WorkerConfig,
  WorkerHandle,
  WorkerSnapshot,
  LoadedModelSnapshot,
} from './interfaces';

const PROTO_PATH = join(__dirname, '../../proto/inference_worker.proto');
const LOADER_OPTIONS = {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

@Injectable()
export class WorkerRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerRegistry.name);
  private readonly workers = new Map<string, WorkerHandle>();
  private readonly snapshots = new Map<string, WorkerSnapshot>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  addWorker(config: WorkerConfig): GpuWorkerService {
    // If worker with this ID exists, close old one first
    if (this.workers.has(config.id)) {
      this.removeWorker(config.id);
    }

    const { service, close } = this.createWorkerService(config);
    const handle: WorkerHandle = { config, service, close };
    this.workers.set(config.id, handle);
    this.logger.log(`Added worker ${config.id} at ${config.url}`);
    return service;
  }

  removeWorker(id: string): void {
    const handle = this.workers.get(id);
    if (!handle) return;

    handle.close();
    this.workers.delete(id);
    this.snapshots.delete(id);
    this.logger.log(`Removed worker ${id}`);
  }

  getWorker(id: string): GpuWorkerService | undefined {
    return this.workers.get(id)?.service;
  }

  getAllWorkers(): WorkerHandle[] {
    return Array.from(this.workers.values());
  }

  getSnapshot(id: string): WorkerSnapshot | undefined {
    return this.snapshots.get(id);
  }

  getAllSnapshots(): WorkerSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  async pollAllWorkers(): Promise<void> {
    const entries = Array.from(this.workers.entries());
    await Promise.all(
      entries.map(([id, handle]) => this.pollWorker(id, handle)),
    );
  }

  startPolling(intervalMs = 5000): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollAllWorkers(), intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  onModuleDestroy(): void {
    this.stopPolling();
    for (const [id] of this.workers) {
      this.removeWorker(id);
    }
  }

  /**
   * Creates a GpuWorkerService with its own gRPC client.
   * Extracted as a method so tests can override it.
   */
  protected createWorkerService(
    config: WorkerConfig,
  ): { service: GpuWorkerService; close: () => void } {
    const grpcClient = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: 'inference.worker.v1',
        protoPath: PROTO_PATH,
        url: config.url,
        loader: LOADER_OPTIONS,
      },
    });

    const service = new GpuWorkerService(grpcClient as any);
    service.init();

    return {
      service,
      close: () => grpcClient.close(),
    };
  }

  private async pollWorker(id: string, handle: WorkerHandle): Promise<void> {
    try {
      const state = await firstValueFrom(handle.service.getWorkerState());
      this.snapshots.set(id, this.toSnapshot(id, state));
    } catch (err) {
      this.logger.warn(`Poll failed for worker ${id}: ${err.message}`);
      // Preserve last known GPU info if we have it, but mark unhealthy
      const existing = this.snapshots.get(id);
      this.snapshots.set(id, {
        workerId: id,
        healthy: false,
        gpu: existing?.gpu ?? {
          vramTotalBytes: 0,
          vramUsedBytes: 0,
          vramAvailableBytes: 0,
          utilization: 0,
          temperatureC: 0,
          healthy: false,
        },
        models: existing?.models ?? [],
        activeInferences: existing?.activeInferences ?? 0,
        queuedInferences: existing?.queuedInferences ?? 0,
        lastUpdated: Date.now(),
      });
    }
  }

  private toSnapshot(workerId: string, state: any): WorkerSnapshot {
    const gpu = state.gpu ?? {};
    const models: LoadedModelSnapshot[] = (state.models ?? []).map(
      (m: any) => ({
        modelId: m.model_id,
        ready: m.ready,
        vramUsedBytes: m.vram_used_bytes ?? 0,
      }),
    );

    return {
      workerId,
      healthy: true,
      gpu: {
        vramTotalBytes: gpu.vram_total_bytes ?? 0,
        vramUsedBytes: gpu.vram_used_bytes ?? 0,
        vramAvailableBytes: gpu.vram_available_bytes ?? 0,
        utilization: gpu.gpu_utilization ?? 0,
        temperatureC: gpu.gpu_temperature_c ?? 0,
        healthy: gpu.healthy ?? true,
      },
      models,
      activeInferences: state.active_inferences ?? 0,
      queuedInferences: state.queued_inferences ?? 0,
      lastUpdated: Date.now(),
    };
  }
}
