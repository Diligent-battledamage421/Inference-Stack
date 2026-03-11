import { WorkerRegistry } from './worker-registry';
import { GpuWorkerService } from '../gpu-worker/gpu-worker.service';
import { of, throwError } from 'rxjs';

/**
 * Create a mock GpuWorkerService with controllable getWorkerState.
 */
function mockWorkerService(stateOverrides: Partial<any> = {}): GpuWorkerService {
  const service = {
    health: jest.fn(() => of({ status: 'HEALTHY', uptime_ms: 1000 })),
    getWorkerState: jest.fn(() =>
      of({
        worker_id: 'mock',
        gpu: {
          vram_total_bytes: 20_000_000_000,
          vram_used_bytes: 2_000_000_000,
          vram_available_bytes: 18_000_000_000,
          gpu_utilization: 0.1,
          gpu_temperature_c: 45,
          healthy: true,
        },
        models: [],
        active_inferences: 0,
        queued_inferences: 0,
        ...stateOverrides,
      }),
    ),
    loadModel: jest.fn(),
    unloadModel: jest.fn(),
    infer: jest.fn(),
    init: jest.fn(),
  } as unknown as GpuWorkerService;
  return service;
}

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;
  let createServiceSpy: jest.SpyInstance;

  beforeEach(() => {
    registry = new WorkerRegistry();
    // Override the internal factory so we don't create real gRPC connections
    createServiceSpy = jest
      .spyOn(registry as any, 'createWorkerService')
      .mockImplementation((config: any) => {
        const service = mockWorkerService({ worker_id: config.id });
        return { service, close: jest.fn() };
      });
  });

  afterEach(() => {
    registry.onModuleDestroy();
  });

  describe('addWorker / getWorker / getAllWorkers', () => {
    it('stores a worker and makes it retrievable by ID', () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });

      expect(registry.getWorker('w-0')).toBeDefined();
      expect(registry.getAllWorkers()).toHaveLength(1);
    });

    it('returns undefined for unknown worker ID', () => {
      expect(registry.getWorker('nope')).toBeUndefined();
    });

    it('supports multiple workers', () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      registry.addWorker({ id: 'w-1', url: 'localhost:50052' });

      expect(registry.getAllWorkers()).toHaveLength(2);
      expect(registry.getWorker('w-0')).toBeDefined();
      expect(registry.getWorker('w-1')).toBeDefined();
    });
  });

  describe('removeWorker', () => {
    it('removes worker and cleans up', () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      registry.removeWorker('w-0');

      expect(registry.getWorker('w-0')).toBeUndefined();
      expect(registry.getAllWorkers()).toHaveLength(0);
    });

    it('calls close on the gRPC client', () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      const handle = (registry as any).workers.get('w-0');
      const closeSpy = handle.close;

      registry.removeWorker('w-0');
      expect(closeSpy).toHaveBeenCalled();
    });

    it('is a no-op for unknown worker ID', () => {
      expect(() => registry.removeWorker('nope')).not.toThrow();
    });
  });

  describe('duplicate worker ID', () => {
    it('replaces the old worker and closes its client', () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      const oldHandle = (registry as any).workers.get('w-0');
      const oldCloseSpy = oldHandle.close;

      registry.addWorker({ id: 'w-0', url: 'localhost:60000' });

      expect(oldCloseSpy).toHaveBeenCalled();
      expect(registry.getAllWorkers()).toHaveLength(1);
      expect((registry as any).workers.get('w-0').config.url).toBe(
        'localhost:60000',
      );
    });
  });

  describe('pollAllWorkers', () => {
    it('updates snapshots with real worker state', async () => {
      createServiceSpy.mockImplementation((config: any) => {
        const service = mockWorkerService({
          worker_id: config.id,
          models: [
            { model_id: 'test-model', ready: true, vram_used_bytes: 500_000_000 },
          ],
          active_inferences: 3,
        });
        return { service, close: jest.fn() };
      });

      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      await registry.pollAllWorkers();

      const snapshot = registry.getSnapshot('w-0');
      expect(snapshot).toBeDefined();
      expect(snapshot!.healthy).toBe(true);
      expect(snapshot!.models).toHaveLength(1);
      expect(snapshot!.models[0].modelId).toBe('test-model');
      expect(snapshot!.activeInferences).toBe(3);
      expect(snapshot!.gpu.vramTotalBytes).toBe(20_000_000_000);
    });

    it('marks worker unhealthy when getWorkerState fails', async () => {
      createServiceSpy.mockImplementation((config: any) => {
        const service = mockWorkerService({ worker_id: config.id });
        (service.getWorkerState as jest.Mock).mockReturnValue(
          throwError(() => new Error('Connection refused')),
        );
        return { service, close: jest.fn() };
      });

      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      await registry.pollAllWorkers();

      const snapshot = registry.getSnapshot('w-0');
      expect(snapshot).toBeDefined();
      expect(snapshot!.healthy).toBe(false);
    });

    it('continues polling other workers when one fails', async () => {
      let callCount = 0;
      createServiceSpy.mockImplementation((config: any) => {
        callCount++;
        const service = mockWorkerService({ worker_id: config.id });
        if (callCount === 1) {
          // First worker fails
          (service.getWorkerState as jest.Mock).mockReturnValue(
            throwError(() => new Error('Dead')),
          );
        }
        return { service, close: jest.fn() };
      });

      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      registry.addWorker({ id: 'w-1', url: 'localhost:50052' });
      await registry.pollAllWorkers();

      expect(registry.getSnapshot('w-0')!.healthy).toBe(false);
      expect(registry.getSnapshot('w-1')!.healthy).toBe(true);
    });
  });

  describe('getAllSnapshots', () => {
    it('returns snapshots for all polled workers', async () => {
      registry.addWorker({ id: 'w-0', url: 'localhost:50051' });
      registry.addWorker({ id: 'w-1', url: 'localhost:50052' });
      await registry.pollAllWorkers();

      const snapshots = registry.getAllSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((s) => s.workerId).sort()).toEqual(['w-0', 'w-1']);
    });
  });
});
