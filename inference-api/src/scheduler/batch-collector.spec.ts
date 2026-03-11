import { BatchCollector } from './batch-collector';

describe('BatchCollector', () => {
  let collector: BatchCollector;

  afterEach(() => {
    collector?.destroy();
  });

  describe('disabled mode', () => {
    it('should dispatch each request immediately when batching is disabled', () => {
      collector = new BatchCollector();
      collector.setConfig({ enabled: false });
      const dispatched: string[] = [];

      collector.submit({
        id: 'r1',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r1'),
      });
      collector.submit({
        id: 'r2',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r2'),
      });

      expect(dispatched).toEqual(['r1', 'r2']);
    });
  });

  describe('window batching', () => {
    it('should batch requests arriving within the time window', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 50,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      // Submit 3 requests within the window
      collector.submit({
        id: 'r1',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r1'),
      });
      collector.submit({
        id: 'r2',
        modelId: 'model-a',
        estimatedTokens: 120,
        dispatch: () => dispatched.push('r2'),
      });
      collector.submit({
        id: 'r3',
        modelId: 'model-a',
        estimatedTokens: 80,
        dispatch: () => dispatched.push('r3'),
      });

      // Not dispatched yet (window hasn't fired)
      expect(dispatched).toHaveLength(0);

      // Wait for window to fire
      await new Promise((r) => setTimeout(r, 70));

      // All 3 should be dispatched as a batch
      expect(dispatched).toEqual(['r1', 'r2', 'r3']);
    });
  });

  describe('max batch size', () => {
    it('should dispatch immediately when max batch size is reached', () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 1000, // long window — should not wait
        maxBatchSize: 2,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      collector.submit({
        id: 'r1',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r1'),
      });

      // Not yet — batch size 1 < max 2
      expect(dispatched).toHaveLength(0);

      collector.submit({
        id: 'r2',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r2'),
      });

      // Immediate dispatch — batch full
      expect(dispatched).toEqual(['r1', 'r2']);
    });

    it('should start a new batch after dispatching a full one', () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 1000,
        maxBatchSize: 2,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      // First batch
      collector.submit({
        id: 'r1',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r1'),
      });
      collector.submit({
        id: 'r2',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r2'),
      });

      expect(dispatched).toEqual(['r1', 'r2']);

      // Second batch
      collector.submit({
        id: 'r3',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r3'),
      });
      collector.submit({
        id: 'r4',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r4'),
      });

      expect(dispatched).toEqual(['r1', 'r2', 'r3', 'r4']);
    });
  });

  describe('compatibility filtering', () => {
    it('should separate incompatible requests into different batches', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 30,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      // Two compatible requests (ratio 120/80 = 1.5 ≤ 4.0)
      collector.submit({
        id: 'short-1',
        modelId: 'model-a',
        estimatedTokens: 80,
        dispatch: () => dispatched.push('short-1'),
      });
      collector.submit({
        id: 'short-2',
        modelId: 'model-a',
        estimatedTokens: 120,
        dispatch: () => dispatched.push('short-2'),
      });

      // One incompatible request (ratio 10000/80 = 125 > 4.0)
      collector.submit({
        id: 'long-1',
        modelId: 'model-a',
        estimatedTokens: 10000,
        dispatch: () => dispatched.push('long-1'),
      });

      // Wait for all windows to fire
      await new Promise((r) => setTimeout(r, 50));

      // All dispatched, but in separate batches
      expect(dispatched).toHaveLength(3);
      expect(dispatched).toContain('short-1');
      expect(dispatched).toContain('short-2');
      expect(dispatched).toContain('long-1');
    });
  });

  describe('multi-model isolation', () => {
    it('should keep batches separate per model', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 30,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      collector.submit({
        id: 'a1',
        modelId: 'model-a',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('a1'),
      });
      collector.submit({
        id: 'b1',
        modelId: 'model-b',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('b1'),
      });

      await new Promise((r) => setTimeout(r, 50));

      // Both dispatched (from separate model buckets)
      expect(dispatched).toHaveLength(2);
    });
  });
});
