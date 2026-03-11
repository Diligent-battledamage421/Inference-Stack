import { Router } from './router';
import { ModelManager } from './model-manager';
import { WorkerRegistry } from './worker-registry';
import { WorkerSnapshot } from './interfaces';

function makeSnapshot(overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    workerId: 'w-0',
    healthy: true,
    gpu: {
      vramTotalBytes: 20e9, vramUsedBytes: 2e9, vramAvailableBytes: 18e9,
      utilization: 0.1, temperatureC: 45, healthy: true,
    },
    models: [],
    activeInferences: 0,
    queuedInferences: 0,
    lastUpdated: Date.now(),
    ...overrides,
  };
}

describe('Router', () => {
  let mockModelManager: jest.Mocked<ModelManager>;
  let mockRegistry: jest.Mocked<WorkerRegistry>;
  let router: Router;

  const fakeWorkerService = { infer: jest.fn() } as any;

  beforeEach(() => {
    mockModelManager = {
      getWorkersWithModel: jest.fn(() => []),
      ensureModelLoaded: jest.fn(),
    } as any;

    mockRegistry = {
      getWorker: jest.fn(() => fakeWorkerService),
      getAllSnapshots: jest.fn(() => []),
    } as any;

    router = new Router(mockModelManager, mockRegistry);
  });

  it('routes directly to worker that already has the model loaded', async () => {
    mockModelManager.getWorkersWithModel.mockReturnValue([
      makeSnapshot({
        workerId: 'w-0',
        models: [{ modelId: 'model-A', ready: true, vramUsedBytes: 500e6 }],
        activeInferences: 1,
      }),
    ]);

    const result = await router.route('model-A');

    expect(result.action).toBe('direct');
    expect(result.workerId).toBe('w-0');
    expect(result.worker).toBe(fakeWorkerService);
    expect(mockModelManager.ensureModelLoaded).not.toHaveBeenCalled();
  });

  it('picks least-loaded worker when multiple have the model', async () => {
    const busyWorker = { infer: jest.fn() } as any;
    const idleWorker = { infer: jest.fn() } as any;

    mockRegistry.getWorker.mockImplementation((id: string) => {
      if (id === 'w-0') return busyWorker;
      if (id === 'w-1') return idleWorker;
      return undefined;
    });

    mockModelManager.getWorkersWithModel.mockReturnValue([
      makeSnapshot({
        workerId: 'w-0',
        models: [{ modelId: 'model-A', ready: true, vramUsedBytes: 500e6 }],
        activeInferences: 8,
        queuedInferences: 3,
      }),
      makeSnapshot({
        workerId: 'w-1',
        models: [{ modelId: 'model-A', ready: true, vramUsedBytes: 500e6 }],
        activeInferences: 1,
        queuedInferences: 0,
      }),
    ]);

    const result = await router.route('model-A');

    expect(result.workerId).toBe('w-1');
    expect(result.worker).toBe(idleWorker);
    expect(result.action).toBe('direct');
  });

  it('triggers model load when no worker has the model', async () => {
    mockModelManager.getWorkersWithModel.mockReturnValue([]);
    mockModelManager.ensureModelLoaded.mockResolvedValue({
      workerId: 'w-0',
      worker: fakeWorkerService,
    });

    const result = await router.route('model-A');

    expect(result.action).toBe('load-then-infer');
    expect(result.workerId).toBe('w-0');
    expect(mockModelManager.ensureModelLoaded).toHaveBeenCalledWith(
      'model-A',
      undefined,
    );
  });

  it('propagates errors from ModelManager', async () => {
    mockModelManager.getWorkersWithModel.mockReturnValue([]);
    mockModelManager.ensureModelLoaded.mockRejectedValue(
      new Error('No worker has capacity to load model X'),
    );

    await expect(router.route('model-X')).rejects.toThrow(/no worker/i);
  });
});
