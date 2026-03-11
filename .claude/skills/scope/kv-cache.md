# KV Cache Routing & Eviction — Detailed Breakdown

## Why KV Cache Routing Is the Hardest Problem

KV cache represents **computed work**. Every token in a conversation's history has been processed through every transformer layer, producing key and value tensors stored on GPU VRAM. Losing this cache means redoing all that computation (prefill), which:
- Increases time-to-first-token dramatically
- Wastes GPU compute that could serve other requests
- Creates unpredictable latency spikes for users

## Routing Scenarios

### A. Session Continuity (Multi-Turn Chat)

**Situation**: User sends turn N of a conversation. GPU-X holds the KV cache from turns 1 through N-1.

**Ideal**: Route to GPU-X. Prefill only needs to process the new user message, not the entire history.

**Complication**: GPU-X might be busy. The decision becomes:
- **Wait cost**: How long until GPU-X is free? (queue depth * avg inference time)
- **Recompute cost**: How many tokens in the history? (prefill time on a cold GPU)
- **Crossover point**: When wait_time > recompute_time, route elsewhere

The system needs a real-time estimate of both costs to make this decision.

### B. Prefix Sharing (Common System Prompts)

**Situation**: Many requests share the same system prompt (e.g., "You are a helpful assistant" — 500 tokens, or a complex agent prompt — 5000 tokens).

**Approach**: Compute the prefix KV cache once per GPU. All requests with that prefix on the same GPU skip prefix prefill.

**Implementation considerations**:
- Prefix tree (trie) mapping token sequences to GPU cache locations
- Prefix matching must be exact (token-level, not string-level)
- Partial prefix matches are valuable — if a request shares the first 3000 of 5000 prefix tokens, those 3000 can be reused
- Popular prefixes should be replicated across multiple GPUs to distribute load

### C. Long Context / Document QA

**Situation**: User uploads a 100K-token document. KV cache is enormous (potentially GBs).

**Approach**: Pin the cache. Route all follow-up queries to that GPU. Eviction cost is extremely high.

**Complications**:
- One document can consume a large fraction of a GPU's KV cache budget
- If the user stops querying, that VRAM is wasted
- TTL-based expiry with generous timeout for long-context caches
- May need to notify user that context was evicted (reupload needed)

## KV Cache Registry

Central data structure tracking all caches across all GPUs:

```
CacheEntry:
  id: string
  gpu_id: string
  model: string
  quantization: string
  token_hash: string          // hash of token sequence
  token_count: number         // for recompute cost estimation
  vram_bytes: number          // actual VRAM consumed
  created_at: timestamp
  last_accessed_at: timestamp
  access_count: number
  session_id: string | null   // null for shared prefix caches
  cache_type: session | prefix | document
  is_pinned: boolean          // prevents eviction
```

## Eviction Policy

### Weighted Score

Each cache gets an eviction score. Lowest score gets evicted first.

```
eviction_score = (recompute_cost * reuse_probability) / vram_consumed
```

Where:
- `recompute_cost` = f(token_count, model_size) — how expensive to recreate
- `reuse_probability` = f(recency, access_frequency, session_active, cache_type)
- `vram_consumed` = actual bytes on GPU

High score = keep. Low score = evict.

### Eviction Cascade Prevention

Problem: Evict cache A → request for A arrives → recompute A → A's prefill evicts cache B → request for B arrives → chain reaction.

Mitigations:
- **Eviction rate limiting**: max N evictions per time window per GPU
- **Grace period**: recently evicted cache IDs get a brief "cool-down" where new requests for them are routed elsewhere rather than triggering recompute on the same GPU
- **Prefill VRAM reservation**: before starting prefill, ensure enough VRAM exists for the new cache WITHOUT evicting anything. If not possible, queue the request instead.

## Cache Migration

Moving a KV cache between GPUs:
- Technically possible (GPU-to-GPU transfer over NVLink or PCIe)
- Expensive in bandwidth and latency
- Only worthwhile for very large caches (100K+ tokens) where recompute would be worse
- Not a V1 feature — recompute is simpler and sufficient initially
