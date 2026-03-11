# Scheduler, Batching & Queue — Detailed Breakdown

## Scheduler Responsibilities

The scheduler is the central orchestrator. For every request, it answers:
1. Which GPU? (informed by router's cache affinity + load balancing)
2. When? (now, queued, rejected)
3. Batched with what? (dynamic batching decisions)
4. How? (standard decoding, speculative decoding)

## Priority System

### Priority Tiers

```
Tier 0: Internal / health checks (always admitted)
Tier 1: Paid realtime (lowest latency SLA)
Tier 2: Paid batch (throughput-optimized, relaxed latency)
Tier 3: Free tier realtime
Tier 4: Free tier batch / background jobs
```

### Fairness Constraints

Priority doesn't mean starvation. Even Tier 4 requests must make progress.

- **Aging**: requests gain priority the longer they wait. A Tier 4 request waiting 30s may outpriority a fresh Tier 2 request.
- **Per-user caps**: no single user (even paid) should consume more than X% of capacity
- **Minimum throughput guarantee**: each tier gets a floor allocation (e.g., Tier 4 always gets at least 5% of capacity)

## Queue Design

### Structure

Per-model queue (not a single global queue):
```
queues:
  llama-70b-fp16: PriorityQueue<InferenceRequest>
  llama-70b-int4: PriorityQueue<InferenceRequest>
  llama-7b-fp16:  PriorityQueue<InferenceRequest>
```

Each queue is a priority queue ordered by effective priority (base tier + aging bonus).

### Backpressure

When queue depth exceeds a threshold:
1. **Soft limit**: start returning estimated wait times in response headers
2. **Hard limit**: reject new requests with 429 + `Retry-After` header
3. **Per-user limit**: reject if a single user has too many queued requests
4. **Token budget limit**: reject if total queued tokens exceed threshold (prevents one user with huge prompts from filling the queue)

### Retry-After Estimation

`Retry-After` should be a real estimate, not a fixed number:
```
retry_after = (queue_depth * avg_inference_time) / num_gpus_for_model
```

Rounded up with some buffer. Bad estimates erode client trust.

## Dynamic Batching

### Why Batch

GPU utilization is poor with one request at a time. Batching multiple requests into a single forward pass increases throughput dramatically (2-8x) with modest latency increase.

### Batching Window

- Accumulate requests for up to `batch_window_ms` (e.g., 5-20ms)
- If `max_batch_size` is reached before the window closes, dispatch immediately
- Tradeoff: longer window = bigger batches = better throughput, but adds latency to every request

### Continuous Batching

Standard batching: wait for all requests in a batch to finish before starting next batch. Wasteful — short requests wait for long ones.

Continuous batching: when a request in the batch finishes generating, its slot is immediately filled by a new request. The batch is always full.

This is the state-of-the-art approach (used by vLLM, TGI). Critical implications:
- Batch composition changes every iteration
- KV cache management must handle mid-batch additions/removals
- Request-level tracking, not batch-level

### Batch Compatibility

Not all requests can be batched together:
- Must be same model
- Must be on same GPU
- Sequence lengths should be similar (padding waste with very different lengths)
- Prefill requests (new) vs decode requests (generating) have different compute profiles — some systems batch them separately

## Speculative Decoding

### Concept

Use a small "draft" model to generate N candidate tokens quickly. Then verify all N tokens in a single forward pass of the large "target" model. If verification succeeds (tokens match), you've generated N tokens for the cost of ~1 large model forward pass.

### Scheduling Implications

- Need both draft model and target model loaded (additional VRAM)
- Draft model runs first, then target model — two-phase inference per step
- Verification failure means falling back to standard decoding for that step
- Scheduler must track draft model placement alongside target model
- Not all requests benefit — short outputs may not be worth the overhead

### When to Use

- Long generation tasks (stories, code, explanations) — high token count, more opportunities for speculation
- When draft model has high acceptance rate for the domain
- When latency matters more than throughput (speculative decoding helps latency, neutral for throughput)

## GPU Assignment Algorithm

Simplified decision flow:

```
1. Filter: GPUs with correct model loaded
2. Prefer: GPU with warm KV cache for this request
3. If no warm cache: prefer GPU with relevant prefix cache
4. Among candidates: prefer GPU with most available VRAM
5. Among candidates: prefer GPU with shortest queue
6. If no GPU has model: trigger model load on least-utilized GPU
7. If all GPUs overloaded: queue or reject
```

Weights for each factor are tunable. The system should support A/B testing different weight configurations.
