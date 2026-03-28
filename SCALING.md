# Markdrop — Scaling Architecture

This document covers how to scale Markdrop from a single-server hobby project to a production system handling thousands of requests per second. Each phase includes real capacity numbers and cost estimates.

---

## Current Architecture (Phase 0 — Today)

```
User → Cloudflare CDN → Vercel (Next.js) → AWS EC2 t2.micro (FastAPI) → MongoDB Atlas (free)
```

**Capacity:** ~10–50 req/s sustained  
**Monthly cost:** ~$0 (free tiers)  
**Bottleneck:** Single EC2 instance, no caching, MongoDB Atlas free tier (512MB storage, shared cluster)

---

## When to Scale

Use these thresholds as triggers:

| Metric | Action |
|--------|--------|
| API p99 latency > 500ms | Add caching layer |
| CPU on EC2 > 70% sustained | Scale vertically or add instances |
| MongoDB Atlas reads > 100/s | Add read replicas or Redis cache |
| > 500 concurrent users | Move to load-balanced setup |
| > 1,000 req/s | Full distributed architecture |

Monitor with: **Datadog** (free tier), **Better Uptime**, or self-hosted **Prometheus + Grafana**.

---

## Phase 1 — Caching Layer (0 → 500 req/s)

**Trigger:** Reads start slowing down. Most traffic is reads (people sharing links).

### Architecture

```
User
  ↓
Cloudflare (cache published pages at edge — 200+ PoPs worldwide)
  ↓ (cache miss only)
Vercel (Next.js SSR + ISR)
  ↓
FastAPI
  ↓
Redis (read cache, 1-hour TTL per slug)     ← NEW
  ↓ (cache miss)
MongoDB Atlas M10 cluster                   ← UPGRADE
```

### What to cache

```
GET /api/v1/documents/{slug}
  → Cache in Redis with key: doc:{slug}
  → TTL: 3600s (1 hour)
  → Invalidate on PUT/DELETE
```

```python
# services/document.py
async def get_document(db, redis, slug):
    cached = await redis.get(f"doc:{slug}")
    if cached:
        return Document(**json.loads(cached))
    
    doc = await db["documents"].find_one({"slug": slug})
    await redis.setex(f"doc:{slug}", 3600, doc.json())
    return doc
```

### Cloudflare edge caching

For published document pages (`markdrop.in/abc123`), Next.js uses ISR (Incremental Static Regeneration):

```typescript
// app/[slug]/page.tsx
export const revalidate = 3600; // re-generate every hour
```

This means Cloudflare + Vercel serve the HTML from cache for 1 hour — zero database hits for reads.

### Capacity math

- Redis (Upstash free): 10,000 req/day free → use Redis Cloud ($7/mo) for production
- Redis can handle **100,000+ req/s** — will never be the bottleneck
- MongoDB Atlas M10 ($57/mo): handles ~1,000 reads/s, 500 writes/s with replica set

**Result:** Reads served from cache in <5ms. MongoDB only sees writes and cache misses.  
**Cost increase:** ~$60/month  
**Capacity:** 500 req/s reads, 50 req/s writes

---

## Phase 2 — Horizontal Scaling (500 → 5,000 req/s)

**Trigger:** Single FastAPI instance CPU pegged, p99 > 1s.

### Architecture

```
User
  ↓
Cloudflare (DDoS protection + edge cache)
  ↓
AWS Application Load Balancer (ALB)         ← NEW
  ↓ (round-robin)
┌─────────────────────────────────────────┐
│  FastAPI instances (Auto Scaling Group) │  ← NEW
│  EC2 t3.small × 3 (min) → × 20 (max)  │
└─────────────────────────────────────────┘
  ↓
Redis Cluster (ElastiCache r7g.large)       ← UPGRADE
  ↓
MongoDB Atlas M30 (3-node replica set)      ← UPGRADE
  ↓
S3 (static assets, future file uploads)
```

### Auto Scaling configuration

```yaml
# AWS Auto Scaling Group
min_instances: 3        # never go below 3 (HA across AZs)
max_instances: 20       # cost cap
scale_out_trigger: CPU > 60% for 2 minutes
scale_in_trigger:  CPU < 30% for 10 minutes
cooldown: 300s
```

### Load Balancer

AWS ALB: ~$16/month base + $0.008/LCU-hour  
At 5,000 req/s: ~$50–80/month for ALB

### Instance sizing math

```
EC2 t3.small (2 vCPU, 2GB RAM):
  - FastAPI with uvicorn (4 workers): ~800 req/s per instance
  - Cost: $15/month per instance

At 5,000 req/s peak:
  - Need: 5,000 / 800 = ~7 instances
  - With 50% headroom: 10 instances
  - Cost: 10 × $15 = $150/month for compute
```

### Database scaling

MongoDB Atlas M30 ($190/month):
- 8GB RAM, 2 vCPU per node
- 3-node replica set (1 primary + 2 secondaries)
- Reads distributed across secondaries
- Handles ~5,000 reads/s, ~1,000 writes/s

**Total Phase 2 cost:** ~$400–500/month  
**Capacity:** 5,000 req/s

---

## Phase 3 — Global Distribution (5,000 → 50,000 req/s)

**Trigger:** Users reporting high latency from specific regions (Asia, Europe).

### Architecture

```
User (anywhere)
  ↓
Cloudflare (anycast routing to nearest PoP)
  ↓
Regional FastAPI clusters (multi-region)
  ├── us-east-1 (primary)    ← AWS
  ├── eu-west-1 (Europe)     ← AWS
  └── ap-southeast-1 (Asia)  ← AWS
  ↓
MongoDB Atlas Global Clusters              ← UPGRADE
  ├── us-east-1 (write primary)
  ├── eu-west-1 (read replica)
  └── ap-southeast-1 (read replica)
  ↓
Redis (ElastiCache Global Datastore)       ← UPGRADE
  └── replicated across regions
```

### Cloudflare Workers for ultra-low latency reads

Move document reads to Cloudflare Workers (runs at edge, 200+ locations):

```javascript
// cloudflare-worker.js
export default {
  async fetch(request, env) {
    const slug = new URL(request.url).pathname.slice(1);
    
    // Check KV store (Cloudflare's edge key-value)
    const cached = await env.DOCS_KV.get(slug, "json");
    if (cached) {
      return Response.json(cached, {
        headers: { "CF-Cache-Status": "HIT" }
      });
    }

    // Fallback to origin
    const response = await fetch(`https://api.markdrop.in/api/v1/documents/${slug}`);
    const doc = await response.json();
    
    // Cache at edge for 1 hour
    await env.DOCS_KV.put(slug, JSON.stringify(doc), { expirationTtl: 3600 });
    return Response.json(doc);
  }
};
```

Cloudflare KV: 100,000 reads/day free, then $0.50 per million reads.  
**Result:** Document reads served in <10ms globally, zero origin load for cached docs.

### MongoDB Global Clusters math

```
Atlas M50 Global Cluster:
  - 3 regions × $400/month = $1,200/month
  - 16GB RAM per node, NVMe SSD
  - Handles: 20,000 reads/s, 5,000 writes/s
  - Automatic geo-routing (writes → primary region, reads → nearest)
```

**Total Phase 3 cost:** ~$3,000–5,000/month  
**Capacity:** 50,000 req/s globally, <50ms p99 anywhere in the world

---

## Phase 4 — Extreme Scale (50,000+ req/s)

At this point Markdrop is a serious platform. Architecture shifts to microservices.

### Architecture

```
Cloudflare (edge cache + DDoS)
  ↓
API Gateway (Kong or AWS API Gateway)
  ├── Rate limiting per IP/user
  ├── Auth middleware
  └── Request routing
  ↓
Microservices (Kubernetes / EKS)
  ├── document-service     (read/write documents)
  ├── search-service       (full-text search via Elasticsearch)
  ├── user-service         (Phase 3 feature: accounts)
  ├── notification-service (webhooks, email)
  └── analytics-service    (view counts, stats)
  ↓
Data layer
  ├── MongoDB (documents)                  sharded cluster
  ├── Redis Cluster (cache + sessions)     6-node cluster
  ├── Elasticsearch (full-text search)     3-node cluster
  └── S3 (file uploads, exports)
```

### Kubernetes scaling math

```
Kubernetes on EKS:
  document-service:
    - 3 replicas minimum (one per AZ)
    - HPA: scale to 50 replicas at peak
    - Each pod: 0.5 vCPU, 512MB RAM
    - 50 pods × 500 req/s = 25,000 req/s from this service alone

  Pod cost: t3.medium nodes ($30/month)
  Nodes needed at peak: ~20 nodes = $600/month compute
```

### MongoDB sharding

When a single replica set maxes out, shard by slug prefix:

```
Shard 1: slugs starting with [a-f]
Shard 2: slugs starting with [g-m]  
Shard 3: slugs starting with [n-s]
Shard 4: slugs starting with [t-z] + [0-9]
```

Each shard is an independent replica set. Queries route automatically via `mongos`.

Atlas M80 sharded: ~$4,000/month per shard × 4 = $16,000/month (for extreme scale)

**Total Phase 4 cost:** $15,000–50,000/month  
**Capacity:** 500,000+ req/s

---

## Cost Progression Summary

| Phase | Req/s | Monthly Cost | Key Addition |
|-------|-------|-------------|--------------|
| 0 — Today | 50 | ~$0 | Single EC2 + free tiers |
| 1 — Caching | 500 | ~$80 | Redis + Cloudflare edge cache |
| 2 — Horizontal | 5,000 | ~$500 | ALB + Auto Scaling + Atlas M30 |
| 3 — Global | 50,000 | ~$4,000 | Multi-region + CF Workers |
| 4 — Extreme | 500,000 | ~$30,000 | Kubernetes + sharded MongoDB |

---

## Latency Targets by Phase

| Phase | p50 | p99 | p999 |
|-------|-----|-----|------|
| 0 | 200ms | 1s | 3s |
| 1 (with cache) | 10ms | 100ms | 500ms |
| 2 (horizontal) | 8ms | 50ms | 200ms |
| 3 (global edge) | 5ms | 20ms | 100ms |
| 4 (Kubernetes) | 3ms | 15ms | 50ms |

---

## Quick Wins — Do These First

Before any infrastructure scaling, these code changes give the biggest gains:

### 1. Projection on MongoDB reads (do this now)

```python
# Only fetch fields you actually need — don't pull edit_secret_hash to the client
doc = await db["documents"].find_one(
    {"slug": slug},
    {"_id": 0, "edit_secret_hash": 0}  # exclude sensitive + unnecessary fields
)
```

**Impact:** 20–40% faster reads, less network bandwidth.

### 2. Connection pooling (do this now)

Motor (which you're using) already pools connections. Make sure the pool size matches your worker count:

```python
# database.py
_client = AsyncIOMotorClient(
    settings.mongodb_uri,
    maxPoolSize=50,       # match to: uvicorn workers × 10
    minPoolSize=5,
    serverSelectionTimeoutMS=3000,
)
```

### 3. Response compression (do this now)

```python
# main.py
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=500)
```

**Impact:** 60–80% reduction in response size for large documents. Faster on mobile.

### 4. Cloudflare Cache Rules (do this now — free)

In Cloudflare dashboard → Cache Rules:
- Cache `markdrop.in/*` (published pages) for 1 hour
- Bypass cache for `api.markdrop.in/*`

**Impact:** Eliminates origin load for repeat visitors to the same document. Effectively infinite read capacity for popular documents.

---

## Key Architectural Principles

1. **Reads are cheap, make them cheaper** — 95% of traffic is reads. Cache aggressively at every layer (Cloudflare → Redis → MongoDB).

2. **Writes are the bottleneck** — Rate limit creates to 10/minute per IP (already done). MongoDB handles writes fine until Phase 3.

3. **Stateless API** — FastAPI instances share no in-memory state. All state lives in MongoDB + Redis. This is why horizontal scaling (Phase 2) is straightforward — just add more instances.

4. **Scale reads before writes** — Add read replicas and caching long before you need write scaling. For a document-sharing tool, write volume is a tiny fraction of read volume.

5. **Cloudflare is free infrastructure** — Use Cloudflare's free tier aggressively. Cache rules, DDoS protection, and edge caching cost $0 on the free plan and absorb massive traffic before it hits your servers.
