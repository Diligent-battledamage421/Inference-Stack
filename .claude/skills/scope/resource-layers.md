# Resource Layers — Detailed Breakdown

## Layer 1: GPU VRAM Budget

Each GPU has a fixed VRAM pool (e.g., 24GB, 40GB, 80GB). This budget is shared between:

- **Model weights**: static once loaded. Size depends on model + quantization level.
  - FP16 70B model: ~140GB (needs tensor parallelism)
  - INT4 70B model: ~35GB (fits on one 40GB GPU)
  - FP16 7B model: ~14GB
- **KV cache storage**: dynamic, grows per active request/session. Size depends on:
  - Number of tokens in context
  - Number of layers and attention heads
  - Precision of cache (FP16 vs FP8)
  - Approximate formula: `2 * num_layers * num_heads * head_dim * seq_len * precision_bytes`

The ratio is not fixed. A GPU running a smaller model has more room for KV caches (more concurrent requests, longer contexts). This tradeoff is a scheduling input.

### VRAM Accounting

The system must track, per GPU:
- Total VRAM
- VRAM used by model weights
- VRAM used by active KV caches (per-request breakdown)
- VRAM reserved for incoming requests (speculative reservation)
- Available VRAM

Speculative reservation is critical — when a request is routed to a GPU, its estimated KV cache VRAM should be reserved before inference starts, to prevent over-subscription.

## Layer 2: Model Placement

Which GPUs have which models loaded. Properties:
- Loading a model takes seconds to minutes (depends on size, storage speed)
- Unloading is fast but destroys all KV caches for that model on that GPU
- A GPU can hold multiple small models simultaneously
- Large models may span multiple GPUs (tensor parallelism)

### Quantization Awareness

The same logical model can exist at different quantization levels:
- GPU-0: llama-70b at INT4 (35GB, lower quality, faster)
- GPU-1: llama-70b at FP16 across GPU-1+GPU-2 (140GB, higher quality, slower)

Router must know which quantization variant is appropriate for the request (some users pay for higher quality).

### Model Placement Decisions

When to load/unload:
- Demand-driven: first request for a model triggers load
- Predictive: pre-load models based on traffic patterns
- Cost-aware: unloading a model with active sessions has high downstream cost

## Layer 3: KV Cache Placement

The most dynamic layer. KV caches are created during inference and persist for potential reuse.

### Cache Identity

A KV cache is identified by:
- Model + quantization level
- Token sequence that produced it (hash of token IDs)
- GPU it resides on (not transferable without explicit migration)

### Cache Types

1. **Session cache**: belongs to a specific conversation, grows with each turn
2. **Prefix cache**: shared across requests with identical prefixes (system prompts)
3. **Document cache**: large context from uploaded documents, pinned for follow-ups

### Cache Lifecycle

```
Created (during prefill) → Active (being used) → Warm (recently used, idle) → Evicted (VRAM reclaimed)
```

Transition from Warm → Evicted is the eviction policy's domain.

## Layer 4: Request Routing

Given a request, determine:
1. Which model (and quantization level)
2. Which GPU (considering cache affinity, load, VRAM)
3. When (now, queued, batched)
4. With what other requests (batching)

This layer consumes information from all three layers below it.