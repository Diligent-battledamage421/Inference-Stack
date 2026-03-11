# Infrastructure Layer — Physical Topology, Network Architecture, Deployment Model

## Physical Topology (Bottom Up)

### GPU Node (the atom)
- Typically 8 GPUs per node (DGX H100 form factor)
- GPUs connected by NVLink + NVSwitch (~900 GB/s bidirectional per GPU)
- This is the unit where **tensor parallelism** lives — one model split across GPUs within a single node
- Each node has InfiniBand NICs (~400 Gbps per NIC, 8 NICs = 3.2 Tbps total) for inter-node communication
- **One inference worker process per GPU**

### Rack (4-8 nodes)
- Nodes connected via InfiniBand Top-of-Rack (ToR) switches
- Pipeline parallelism can span nodes within a rack (latency is low enough)
- Power-limited to ~40-70 kW per rack depending on cooling

### Cluster / SuperPOD (~256 GPUs, 32 nodes)
- Rail-optimized InfiniBand fabric — any node is one hop from any other
- This is the **largest unit where a single model inference can execute**
- A single inference request NEVER spans clusters

### Data Center (many clusters)
- Clusters connected via spine switches
- Cross-cluster latency makes tensor/pipeline parallelism infeasible
- Routing is per-request, not per-tensor — entire request handled within one cluster

### Cross-Data Center
- A single inference request **NEVER spans data centers**
- Each data center runs complete, independent model replicas
- A global router decides which data center handles each request
- Model weights distributed via object storage (S3/GCS) with caching

## Separation of Concerns

### Three Distinct Planes

**1. Control Plane** (CPU-only nodes, separate cluster)
- Model registry: tracks which models are on which GPUs/clusters/replicas
- Health monitoring: GPU temps, VRAM usage, inference latency, error rates
- Autoscaler: spin up/down replicas based on traffic patterns
- Deployment orchestration: model rollouts, blue-green, canary
- **Does NOT touch inference data (inputs/outputs)**
- Hub-and-spoke model: centralized control, distributed execution

**2. Data Plane — Gateway Layer** (CPU-only nodes)
- API Gateway: auth, rate limiting, request validation, API versioning
- LLM-Aware Router: understands KV cache state, VRAM pressure, queue depth
  - Standard L7 load balancers (round-robin, least-connections) FAIL here
  - They have no visibility into KV cache state or request compute cost
  - A GPU with 95% KV cache utilization should not receive new requests even if connection count is low
- Request flow: HTTP in → tokenize → route → gRPC to GPU worker

**3. Data Plane — GPU Workers** (GPU nodes)
- Only do inference
- One worker process per GPU
- Receive tokenized requests via gRPC/ZMQ
- Return tokens (streaming or batch)
- Report metrics back to control plane (VRAM, cache state, queue depth)

### Why This Separation Matters
- GPU machines are expensive — don't waste GPU cycles on HTTP handling, auth, tokenization
- API gateway scales independently of GPU capacity
- Control plane can go down without interrupting active inference
- GPU workers can be on completely different networks/providers

## Communication Protocols

### Client → API Gateway
- HTTPS (REST), Server-Sent Events for streaming
- Standard web infrastructure

### API Gateway → GPU Workers
- **gRPC** preferred over REST for internal communication
  - Connection pooling and multiplexing
  - Protobuf efficiency (smaller payloads)
  - Built-in streaming (bidirectional)
  - Automatic keepalives and health checks
  - Strong typing via proto definitions

### GPU Workers → Control Plane
- Metrics push (Prometheus/OpenTelemetry) or pull
- Health heartbeats
- Cache state reports (which KV caches are held, VRAM utilization)

### Within GPU Node
- ZMQ IPC (vLLM's approach) or shared memory for API server → engine core
- NCCL for GPU-to-GPU collective operations (tensor parallelism)
- MPI alternative for multi-GPU coordination (TensorRT-LLM)

## Load Balancing Layers (4-5 deep)

### Layer 1 — Global / DNS
- GeoDNS or Anycast routes users to nearest region
- CloudFlare, AWS Global Accelerator, or equivalent

### Layer 2 — Regional API Gateway
- L7 load balancer (Envoy, NGINX, cloud ALB)
- Auth, rate limiting, request validation
- API key → tenant → quota enforcement

### Layer 3 — Model-Level Routing
- Routes to a specific model's replica pool
- Knows which clusters serve which models
- Kubernetes-native: Gateway API Inference Extension (CRDs: InferenceModel, InferencePool)

### Layer 4 — Replica-Level / LLM-Aware Routing
- This is where standard LBs fail and LLM-specific routing lives
- Understands: KV cache pressure, queue depth, prefill vs decode phase
- Session affinity for multi-turn conversations (KV cache reuse)
- vLLM Router (Rust) operates at this layer

### Layer 5 — Disaggregated Routing (emerging)
- NVIDIA Dynamo: routes prefill and decode phases to different GPU pools
- KV cache transfer between prefill and decode GPUs
- Up to 30x throughput improvement on large models

## Scale Examples

### Hyperscaler (OpenAI/Anthropic)
- Tens of thousands of GPUs across multiple data centers
- GPT-4: ~128 GPUs per replica (TP=8, PP=16), hundreds of replicas
- Anthropic: mixed hardware (NVIDIA GPUs, AWS Trainium, GCP TPUs)
- Sophisticated model registry tracking hardware type + model binary compatibility
- Shared hardware pools: inference during day, training during off-peak

### Mid-Scale (Fireworks, Together, Baseten)
- 8+ cloud providers, 18+ regions
- Hundreds of thousands of queries/second
- Control plane on managed Kubernetes (GKE)
- Model weights cached via distributed storage (Alluxio) for fast cold starts
- Unified GPU pool abstraction across clouds

### Small Player (5-15 GPUs across providers)
- Each rented node runs independent model replicas
- NO cross-node tensor parallelism (network too slow between providers)
- Limited to models that fit on a single node
- Lightweight global router dispatches requests to nodes
- Must handle: heterogeneous GPU types, variable network latency, spot instance preemption

## Our Simulation Setup

### What Maps to What

```
LOCAL MACHINE (MacBook)                RUNPOD (2x RTX A4500, 20GB each)
┌────────────────────────┐            ┌─────────────────────────┐
│                        │            │                         │
│  CONTROL PLANE         │            │  GPU CLUSTER            │
│  ├─ Model Registry     │            │  ┌───────────────────┐  │
│  ├─ Health Monitor     │            │  │ GPU Worker 0       │  │
│  └─ Autoscaler         │            │  │ SmolLM2-135M       │  │
│                        │            │  │ RTX A4500, 20GB    │  │
│  DATA PLANE GATEWAY    │            │  └───────────────────┘  │
│  ├─ NestJS API         │◄──gRPC───►│  ┌───────────────────┐  │
│  ├─ LLM-Aware Router   │            │  │ GPU Worker 1       │  │
│  ├─ Scheduler          │            │  │ SmolLM2-360M       │  │
│  ├─ KV Cache Manager   │            │  │ RTX A4500, 20GB    │  │
│  └─ Batch Formation    │            │  └───────────────────┘  │
│                        │            │                         │
│  TEST SUITE            │            │  Worker process exposes │
│  ├─ Integration tests  │            │  gRPC: health, infer,   │
│  ├─ E2E tests          │            │  cancel, cache_state,   │
│  └─ Traffic simulation │            │  load_model, unload     │
│                        │            │                         │
└────────────────────────┘            └─────────────────────────┘
```

### What This Simulates
- **Network hop latency**: Mac ↔ RunPod simulates real API-to-GPU-cluster latency
- **Two-GPU cluster**: Small player with limited compute in one location
- **Independent workers**: Each GPU runs its own worker, own model — like two replicas
- **Resource constraints**: 20GB VRAM per GPU — real constraint forcing real eviction/scheduling decisions
- **Model heterogeneity**: Two different models (135M, 360M) — router must know which GPU has which

### What It Doesn't Simulate (and how to account for it)
- **Multi-datacenter**: Could simulate by adding artificial latency to one GPU's gRPC calls
- **Tensor parallelism**: Models too small to need it — acceptable tradeoff for learning
- **Spot preemption**: Could simulate by randomly killing a GPU worker process
- **Scale**: 2 GPUs not 2000 — but the scheduling/routing logic is identical
