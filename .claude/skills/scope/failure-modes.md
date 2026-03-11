# Failure Modes — Detailed Breakdown

## GPU OOM Mid-Inference

**Cause**: KV cache grows beyond available VRAM during generation (long output), or VRAM accounting was imprecise.

**Response**:
1. Catch OOM from GPU worker
2. Mark request as retriable
3. Attempt on different GPU (if available) with conservative VRAM reservation
4. If all GPUs fail OOM → return error to client with clear message
5. Track retry count — don't retry infinitely (max 2 retries)

**Prevention**: Conservative VRAM reservation. Estimate max KV cache size based on `max_tokens` parameter before scheduling.

## Worker Process Crash

**Cause**: Segfault in GPU driver, CUDA error, process killed by OOM killer.

**Response**:
1. Detect crash via health check / process monitor
2. Mark GPU as unhealthy
3. All in-flight requests on that GPU → error callback
4. Queued requests for that GPU → re-route to other GPUs
5. Attempt GPU worker restart
6. Once healthy → gradually reintroduce (don't send full load immediately)

**Key concern**: Requests in-flight are lost. Streaming responses may be partially delivered. Client must handle partial stream + error gracefully.

## Model Load Failure

**Cause**: Corrupt weights, incompatible GPU, insufficient VRAM (fragmentation), disk I/O error.

**Response**:
1. Mark model as failed-to-load on this GPU
2. Don't retry on same GPU immediately (backoff)
3. Try loading on different GPU if available
4. If no GPU can load → mark model as unavailable, return 503

## Timeout on Long Sequences

**Cause**: Very long input or output, model stuck in loop, slow GPU.

**Response**:
- Per-model configurable timeout (absolute wall time)
- Per-request `max_tokens` as a generation cap
- Streaming timeout: if no token emitted for N seconds, kill inference
- Return partial results if streaming, error if non-streaming

## Cascading Eviction

**Cause**: Eviction of cache A triggers recompute → recompute evicts cache B → request for B triggers recompute → chain reaction.

**Response**:
- Eviction rate limiter: max N evictions per GPU per time window
- Grace period on evicted cache IDs (don't recompute on same GPU immediately)
- Pre-check VRAM availability before starting prefill — if eviction would be needed, queue the request instead
- Circuit breaker: if eviction rate exceeds threshold, stop admitting new requests to that GPU temporarily

## GPU Crash with Active Sessions (Session Migration)

**Cause**: GPU hardware failure, driver crash, node goes down.

**Impact**: All KV caches on that GPU are lost. Multiple active conversations lose their cached context.

**Response**:
1. Identify affected sessions from cache registry
2. Do NOT recompute all of them simultaneously (thundering herd)
3. Spread recomputation across available GPUs using a ramp-up schedule
4. Priority order: most recently active sessions first
5. Inform affected clients of temporary latency increase (via streaming metadata or header)

**Thundering herd prevention**:
- Stagger recomputation over time (e.g., N sessions per second)
- Random jitter on recomputation start
- Backpressure: if receiving GPUs are busy, queue recomputation

## Model Swap with Active KV Caches

**Cause**: Need to load model B on a GPU that currently holds model A with active KV caches.

**Impact**: All KV caches for model A on that GPU are destroyed.

**Decision**: Is it worth it?
- Calculate total recompute cost of destroyed KV caches
- Compare against benefit of loading model B (how many requests are waiting for B?)
- If cost > benefit → load model B elsewhere, or queue model B requests
- If benefit > cost → proceed, but handle session migration for affected model A users

## Network Partition (Multi-Node)

**Cause**: Network between API server and GPU worker nodes fails.

**Response**:
1. Health checks detect partition
2. Mark unreachable GPUs as unavailable
3. Re-route to reachable GPUs
4. When partition heals → reconcile state (which caches survived?)
5. Don't assume caches on the other side of a partition are still valid

## Partial Streaming Failure

**Cause**: Stream starts successfully, then GPU worker crashes mid-generation.

**Response**:
- Client receives partial tokens, then an error event in the stream
- Error event includes: how many tokens were generated, whether retry is possible
- Client can retry with the partial output appended to context (though this isn't ideal)
- System should NOT auto-retry streaming requests (client may have already displayed partial output)

## Degraded Mode

When overall capacity drops (GPUs go offline), the system must degrade gracefully:
1. Tighten rate limits automatically
2. Reject lower-priority tiers first
3. Disable speculative decoding (frees draft model VRAM)
4. Reduce max batch sizes (trade throughput for reliability)
5. Extend queue timeouts (better to wait than error)
6. Notify monitoring / alerting systems
