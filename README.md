# HTTP Load Orchestrator

A **distributed HTTP load-testing backend**: clients submit tests (URL, method, volume, concurrency), work runs **asynchronously** on workers, and results are stored in **PostgreSQL** with **Redis** for the job queue, idempotency, and live progress.

---

## Table of contents

- [Overview](#overview)
- [System design](#system-design)
- [Architecture diagrams](#architecture-diagrams)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Data model](#data-model)
- [Configuration](#configuration)
- [Setup](#setup)
- [API](#api)
- [Worker behavior](#worker-behavior)
- [Reliability: checkpoints, staleness, recovery](#reliability-checkpoints-staleness-recovery)
- [Scaling and production notes](#scaling-and-production-notes)
- [Troubleshooting](#troubleshooting)

---

## Overview

| Capability | Description |
|------------|-------------|
| **Async execution** | `POST /tests` returns quickly (`202`); a [BullMQ](https://docs.bullmq.io/) worker pool executes HTTP requests against the target. |
| **Concurrency control** | Each test specifies `concurrency` (max in-flight requests for that test). |
| **Persistence** | Test definitions and per-request metrics live in PostgreSQL; Redis holds the queue, short-lived idempotency keys, and in-flight progress. |
| **Idempotent submits** | Same user + same test parameters within **60 seconds** map to the same `testId` (fingerprint in Redis). |
| **Progress** | While `PENDING` / `RUNNING`, clients can poll `GET /tests/:id` for `completedRequests` / `failedRequests` (from Redis). |
| **Aggregated metrics** | When `COMPLETED`, responses include success/error rates, average latency, and throughput (derived from stored metrics + timestamps). |
| **Rate limiting** | Test routes are limited (default **5 submissions per minute** per `x-user-id` or client IP). |
| **Tracing** | `x-request-id` / `x-trace-id` are honored; otherwise a UUID is assigned per request. |

---

## System design

### High-level components

1. **API service (`src/api/server.ts`)**  
   Express app: validates input (Zod), writes/reads PostgreSQL, enqueues jobs on Redis/BullMQ, exposes health and test APIs.

2. **Queue (`src/queue/testQueue.ts`)**  
   BullMQ queue named `loadTests`. Jobs carry `{ testId, traceId? }` and are processed by workers.

3. **Workers (`src/workers/worker.ts`)**  
   Separate Node processes that pull jobs, issue HTTP requests via Axios (timeout **10s**, retries via `axios-retry`), batch-insert metrics, and checkpoint progress.

4. **PostgreSQL**  
   Source of truth for tests and metrics; schema is created/altered on startup in `initDb()` (`src/infra/db.ts`).

5. **Redis**  
   BullMQ backend, idempotency (`SET` fingerprint → `testId`, TTL 60s), progress keys `test:<id>:progress`, and a short-lived leader lock for orphan recovery.

### Request lifecycle (summary)

1. Client `POST /tests` → validate → optional duplicate check (Redis fingerprint).
2. Insert row `tests` with `PENDING`, enqueue `runTest` job → **202** + `testId`.
3. Worker picks job → may resume from Redis/DB → set `RUNNING`, execute request loop with concurrency cap, flush metrics in waves, update checkpoints.
4. On success → `COMPLETED` + `completed_at`; progress key removed.

### Design tradeoffs

- **At-least-once job processing**: BullMQ may redeliver; idempotency and checkpointing avoid double-counting at the business level (resume from last completed offset).
- **Wave-based DB writes**: Metrics are inserted in slices (each ~`concurrency` completions) to balance resume granularity vs write load.
- **Staleness guard**: If a `RUNNING` test’s last checkpoint is older than **15 seconds** when a worker runs, the test is marked **FAILED** to avoid ambiguous resume after long outages (see [Worker behavior](#worker-behavior)).

---

## Architecture diagrams

### Component view

```mermaid
flowchart TB
  subgraph clients [Clients]
    C[HTTP clients]
  end

  subgraph api [API]
    E[Express]
    T[traceId middleware]
    RL[Rate limiter]
    Ctrl[tests controller]
    E --> T --> RL --> Ctrl
  end

  subgraph queue [Queue]
    Q[BullMQ queue: loadTests]
  end

  subgraph workers [Workers]
    W1[Worker process]
    W2[Worker process]
  end

  Redis[(Redis)]
  PG[(PostgreSQL)]
  Target[Target HTTP APIs]

  C --> E
  Ctrl --> PG
  Ctrl --> Redis
  Ctrl --> Q
  Q --> W1
  Q --> W2
  W1 --> Redis
  W1 --> PG
  W1 --> Target
  W2 --> Redis
  W2 --> PG
  W2 --> Target
```

### Sequence: submit and execute

```mermaid
sequenceDiagram
  participant Client
  participant API
  participant Redis
  participant PG as PostgreSQL
  participant Queue as BullMQ
  participant Worker
  participant Target

  Client->>API: POST /tests
  API->>API: Zod validate, fingerprint
  API->>Redis: GET fingerprint
  alt duplicate within 60s
    Redis-->>API: existing testId
    API-->>Client: 200 duplicate
  else new test
    API->>PG: INSERT tests PENDING
    API->>Redis: SET fingerprint EX 60
    API->>Queue: add job runTest
    API-->>Client: 202 Accepted
  end

  Queue->>Worker: job testId traceId
  Worker->>PG: SELECT test, staleness / resume offset
  Worker->>PG: UPDATE RUNNING
  loop until request_count
    Worker->>Target: HTTP
    Target-->>Worker: response / error
    Worker->>Worker: wave checkpoint metrics + progress
  end
  Worker->>PG: UPDATE COMPLETED
  Worker->>Redis: DEL progress
```

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js, TypeScript (CommonJS build to `dist/`) |
| HTTP API | Express 5 |
| Validation | Zod |
| Queue | BullMQ on Redis (ioredis) |
| Database | PostgreSQL (`pg` pool) |
| HTTP client | Axios + axios-retry |
| Rate limiting | express-rate-limit |

---

## Repository layout

```text
src/
  api/
    server.ts              # Express app, health, shutdown
    routes/tests.ts        # Mounts /tests routes + rate limit
    controllers/testsController.ts
  workers/worker.ts        # BullMQ worker: HTTP load + metrics
  queue/testQueue.ts       # BullMQ queue helpers
  infra/
    db.ts                  # PostgreSQL pool + migrations on boot
    redis.ts               # Redis client
  schemas/loadTestSchema.ts
  middleware/traceId.ts
  utils/                   # axios, metrics, recovery, fingerprint, etc.
```

---

## Data model

Created/updated automatically when the API or worker calls `initDb()`:

**`tests`**

| Column | Role |
|--------|------|
| `id` | UUID primary key |
| `url`, `method`, `headers`, `payload` | Target and request body (headers/payload stored as JSON strings) |
| `request_count`, `concurrency` | Load parameters |
| `status` | `PENDING` → `RUNNING` → `COMPLETED` or `FAILED` |
| `created_at`, `completed_at`, `trace_id` | Auditing |
| `last_checkpoint_at`, `completed_requests` | Resume and staleness |

**`metrics`**

Per-request rows: `status_code`, `response_ms`, `success`, optional `error_msg`, `timestamp`.

---

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | API listen port |
| `DATABASE_URL` | — | Preferred: full Postgres URL |
| `POSTGRES_HOST` | `localhost` | Used if `DATABASE_URL` unset |
| `POSTGRES_PORT` | `5432` | |
| `POSTGRES_USER` | `postgres` | |
| `POSTGRES_PASSWORD` | `postgres` | |
| `POSTGRES_DB` | `loadtests` | |
| `REDIS_HOST` | `127.0.0.1` | |
| `REDIS_PORT` | `6379` | |
| `LOADTEST_MAX_REQUEST_COUNT` | `100000` | Max `requestCount` (Zod) |
| `LOADTEST_MAX_CONCURRENCY` | `1000` | Max `concurrency` (Zod) |
| `WORKER_CONCURRENCY` | `10` | Parallel **jobs** per worker process (BullMQ worker option) |

Axios timeout is **10 seconds** (see `src/utils/axios.ts`).

---

## Setup

### Prerequisites

- Node.js 20+
- Redis and PostgreSQL (local or Docker)

### Local development

```bash
npm install
# Ensure Redis and Postgres are running; set DATABASE_URL or POSTGRES_* in .env

npm run dev          # API (nodemon + ts-node)
npm run worker       # after: npm run build — or use ts-node for worker if you add a script
```

For production-style runs, compile first:

```bash
npm run build
npm run start        # API: node dist/api/server.js
npm run worker       # Worker: node dist/workers/worker.js
```

### Docker Compose

The repo includes `docker-compose.yml` with **Redis**, **PostgreSQL**, **api**, and **worker** (2 replicas). Example:

```bash
docker compose up --build
```

- API: `http://localhost:3000`
- Postgres and Redis use named volumes (`postgres-data`, `redis-data`).

Copy `.env` as needed; the sample uses `DATABASE_URL=postgres://postgres:postgres@postgres:5432/loadtests` and `REDIS_HOST=redis`.

---

## API

Base path: `/tests` (all routes below are under this prefix; rate limiting applies).

### `GET /health`

Checks Redis (`PING`) and PostgreSQL (`SELECT 1`). **200** `{ status, redis, db }` or **503** if either fails.

### `POST /tests`

Body (JSON), validated by `LoadTestSchema`:

| Field | Type | Notes |
|-------|------|--------|
| `url` | string | Valid URL |
| `method` | enum | `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `headers` | optional object | String keys/values |
| `payload` | optional any | For `application/x-www-form-urlencoded`, payload can be stringified per `Content-Type` in worker |
| `requestCount` | positive int | Capped by `LOADTEST_MAX_REQUEST_COUNT` |
| `concurrency` | positive int | Capped by `LOADTEST_MAX_CONCURRENCY` |

Headers:

- `x-user-id` — used for idempotency fingerprint and rate-limit key (default identity: `anonymous`).

Responses:

- **202** — New test queued: `{ testId, message }`.
- **200** — Duplicate within window: `{ testId, message: "Duplicate submission ignored" }`.

### `GET /tests/:id`

Returns test status. Optional `traceId` when stored.

- **`PENDING` / `RUNNING`**: includes `progress`: `totalRequests`, `completedRequests`, `failedRequests` (from Redis when available).
- **`COMPLETED`**: includes `metrics` (aggregated): `totalRequests`, `successRate`, `errorRate`, `avgResponseMs`, `throughput`.
- **`FAILED`**: status and timestamps; partial metrics may exist depending on failure mode.

### `GET /tests`

Lists tests with aggregated error rate and throughput where computable.

Query parameters (all optional): `method`, `url`, `minErrorRate`, `maxErrorRate`, `minThroughput`, `maxThroughput`.

**Note:** Express routing defines `GET /:id` before `GET /`; `GET /tests` (list) and `GET /tests/<uuid>` (detail) behave as expected for standard paths.

---

## Worker behavior

- **Concurrency (per test):** The worker maintains up to `test.concurrency` in-flight HTTP calls using `Promise.race` / batching (see `worker.ts`).
- **Checkpoint:** After each “wave” of approximately `concurrency` completions, metrics are written to PostgreSQL and Redis `test:<testId>:progress` is updated; `tests.last_checkpoint_at` and `completed_requests` are updated.
- **Resume:** On job start, offset = Redis progress `completedRequests`, else `completed_requests` from DB.
- **Staleness:** If status is `RUNNING` and `last_checkpoint_at` is older than **15s**, the worker sets status `FAILED` and skips execution (avoids unsafe resume).
- **Completion:** Sets `COMPLETED`, `completed_at`, removes progress key.

---

## Reliability: checkpoints, staleness, recovery

| Mechanism | Purpose |
|-----------|---------|
| **BullMQ** | Durable jobs; configurable lock duration/renewal for long tests |
| **Checkpoints** | Resume after worker crash without redoing all requests |
| **Leader lock** (`loadtest:recovery:leader`) | Only one worker runs orphan recovery at a time |
| **Orphan recovery** (`src/utils/recovery.ts`) | On worker startup, if this process holds the lock **and** the queue has no waiting/active jobs, re-queue jobs for rows still `RUNNING` so they can resume or fail per staleness rules |

**Caveats**

- If Redis is down, live progress on `GET /tests/:id` may show zeros until the next successful checkpoint.
- Recovery only runs when workers start and the conditions above hold; heavily loaded queues delay orphan re-queueing.

---

## Scaling and production notes

- **Horizontal scaling:** Run multiple worker containers/processes with the same `REDIS_HOST` and `DATABASE_URL`; BullMQ coordinates job consumers.
- **`WORKER_CONCURRENCY`:** Increases how many **different tests** one process handles concurrently (not the HTTP concurrency inside a single test—that is `request.body.concurrency`).
- **Observability:** Add structured logs and metrics (queue depth, job failures, DB latency); trace IDs are already propagated where logged.
- **Safety:** Rate limits and idempotency reduce accidental overload; production systems still need auth, allowlists, and fair quotas for who may target which URLs.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| **503 on `/health`** | Redis and Postgres reachable from the API container/host |
| **Test stays `PENDING`** | At least one worker running, same Redis, queue name `loadTests` |
| **Stuck `RUNNING`** | Worker logs, BullMQ stalled jobs; restart workers to trigger recovery when queue is idle |
| **429 on submit** | Rate limit: 5/min per user/IP; wait or adjust `src/utils/rateLimiter.ts` |

---

## License

ISC (see `package.json`).
