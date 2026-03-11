/**
 * Integration Test: Dynamic Batching
 *
 * Tests BatchCollector integration with real timing and batch formation.
 * Verifies window-based batching, max-size dispatch, and compatibility filtering.
 *
 * Scope reference: test-scenarios.md — T11, T12, T13
 */
import { BatchCollector } from '../../src/scheduler/batch-collector';

describe('Dynamic Batching (Integration)', () => {
  let collector: BatchCollector;

  afterEach(() => {
    collector?.destroy();
  });

  describe('T11: Batch formation within time window', () => {
    it('should batch requests arriving within the batching window', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 30,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const batchTimestamps: number[] = [];

      for (let i = 0; i < 3; i++) {
        collector.submit({
          id: `req-${i}`,
          modelId: 'SmolLM2-135M',
          estimatedTokens: 50,
          dispatch: () => batchTimestamps.push(Date.now()),
        });
      }

      expect(batchTimestamps).toHaveLength(0);

      await new Promise((r) => setTimeout(r, 50));

      expect(batchTimestamps).toHaveLength(3);
      const spread = Math.max(...batchTimestamps) - Math.min(...batchTimestamps);
      expect(spread).toBeLessThan(10);
    });

    it('should dispatch immediately when max batch size is reached before window closes', () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 500,
        maxBatchSize: 2,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];
      const start = Date.now();

      collector.submit({
        id: 'r1',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 50,
        dispatch: () => dispatched.push('r1'),
      });
      collector.submit({
        id: 'r2',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 50,
        dispatch: () => dispatched.push('r2'),
      });

      const elapsed = Date.now() - start;
      expect(dispatched).toEqual(['r1', 'r2']);
      expect(elapsed).toBeLessThan(10);
    });
  });

  describe('T12: Continuous batching slot reclamation', () => {
    it.skip('requires GPU worker continuous batching support — Python worker changes needed', () => {});
  });

  describe('T13: Batch compatibility filtering', () => {
    it('should not batch requests with vastly different sequence lengths', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 30,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const shortBatch: string[] = [];
      const longBatch: string[] = [];

      collector.submit({
        id: 'short-1',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 100,
        dispatch: () => shortBatch.push('short-1'),
      });
      collector.submit({
        id: 'short-2',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 100,
        dispatch: () => shortBatch.push('short-2'),
      });
      collector.submit({
        id: 'long-1',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 50000,
        dispatch: () => longBatch.push('long-1'),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(shortBatch).toEqual(['short-1', 'short-2']);
      expect(longBatch).toEqual(['long-1']);
    });

    it('should batch requests with similar token counts', async () => {
      collector = new BatchCollector();
      collector.setConfig({
        enabled: true,
        windowMs: 30,
        maxBatchSize: 10,
        maxSeqLengthRatio: 4.0,
      });

      const dispatched: string[] = [];

      collector.submit({
        id: 'r1',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 100,
        dispatch: () => dispatched.push('r1'),
      });
      collector.submit({
        id: 'r2',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 200,
        dispatch: () => dispatched.push('r2'),
      });
      collector.submit({
        id: 'r3',
        modelId: 'SmolLM2-135M',
        estimatedTokens: 300,
        dispatch: () => dispatched.push('r3'),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(dispatched).toEqual(['r1', 'r2', 'r3']);
    });
  });
});
