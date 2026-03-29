# HTTP Load Orchestrato - Detailed Project Guide

This document is a deep technical walkthrough of the project so you can understand how it works end-to-end, not just how to run it.

## 1) What this project is

This is a backend load-test orchestration service built with Node.js + TypeScript.

At a high level:
- An API accepts load-test definitions.
- Tests are persisted in PostgreSQL.
- Jobs are queued in Redis via BullMQ.
- A worker process executes requests against target URLs.
- Per-request metrics are written to PostgreSQL.
- API endpoints expose test status, progress, and aggregate metrics.

It is designed around async orchestration so API requests stay fast while long-running tests execute in the background.

## 2) Tech stack and why each piece exists

- `Express`: HTTP API server.
- `BullMQ`: Queue + worker model for background execution.
- `ioredis`: Redis client for BullMQ, idempotency keys, and progress state.
- `pg`: PostgreSQL client for persistent storage.
- `axios` + `axios-retry`: Outbound HTTP load execution with retry behavior.
- `zod`: Runtime request validation.
- `express-rate-limit`: Protect `/tests` endpoints from abuse.
- `dotenv`: Environment variable loading.
- `TypeScript`: Typed code with compile step to `dist`.

## 3) Repository layout

Key files and folders:

- `src/api/server.ts`
  - API process entrypoint.
  - Boots DB + Redis and mounts routes.
- `src/api/routes/tests.ts`
  - `/tests` route definitions.
- `src/api/controllers/testsController.ts`
  - Main API business logic (`POST /tests`, `GET /tests/:id`, `GET /tests`).
- `src/workers/worker.ts`
  - Worker entrypoint and main execution loop for load jobs.
- `src/queue/testQueue.ts`
  - Queue singleton and enqueue helper.
- `src/infra/db.ts`
  - PostgreSQL connection and schema bootstrap (`CREATE TABLE IF NOT EXISTS`).
- `src/infra/redis.ts`
  - Redis connection singleton.
- `src/schemas/loadTestSchema.ts`
  - Zod schema with env-driven limits.
- `src/utils/*`
  - Cross-cutting concerns: retries, error response shaping, env parsing, recovery, metric aggregation, etc.
- `docker-compose.yml`, `Dockerfile`
  - Containerized local/prod-like execution.
- `dist/`
  - Compiled JavaScript output.

## 4) Runtime model (two-process architecture)

You usually run **two processes**:

1. **API process**
   - Accepts requests and enqueues jobs.
   - Command (dev): `npm run dev`
   - Command (prod-like): `npm run start`

2. **Worker process**
   - Pulls jobs from queue and executes load tests.
   - Command: `npm run worker`

Why split this way:
- API remains responsive.
- Test execution can scale independently from request handling.
- Worker crash/restart can be recovered from checkpoints.

## 5) End-to-end request flow

### Step A: Submit test (`POST /tests`)

Path: `src/api/controllers/testsController.ts`

1. Validate request payload with `LoadTestSchema`.
2. Determine `traceId` from middleware or generate one.
3. Build an idempotency fingerprint (`x-user-id` + payload).
4. Check Redis for existing fingerprint:
   - If found: return existing `testId` with duplicate message.
   - If not found: continue.
5. Insert row in `tests` table with status `PENDING`.
6. Save fingerprint -> `testId` in Redis for 60 seconds.
7. Enqueue BullMQ job with `testId` and `traceId`.
8. Return `202 Accepted`.

### Step B: Worker executes queued job

Path: `src/workers/worker.ts`

1. Fetch test row from DB.
2. Apply staleness guard for old `RUNNING` jobs.
3. Derive resume offset from Redis progress or DB checkpoint.
4. Mark test `RUNNING`.
5. Execute outbound HTTP requests with per-test concurrency.
6. Persist metrics in slices.
7. Save checkpoint progress in Redis + DB.
8. Mark test `COMPLETED` (or `FAILED` on stale/fatal errors).
9. Delete Redis progress key.

### Step C: Read results (`GET /tests/:id`)

Path: `src/api/controllers/testsController.ts`

- If status is `PENDING` or `RUNNING`: return live progress.
- If completed: aggregate `metrics` rows to compute:
  - total requests
  - success/error rates
  - average response time
  - throughput

## 6) API surface in detail

### `GET /health`

- Checks Redis (`PING`) and DB (`SELECT 1`).
- Returns `200` when both are healthy.
- Returns `503` otherwise.

### `POST /tests`

Expected body shape:
- `url` (valid URL string)
- `method` (`GET|POST|PUT|DELETE|PATCH`)
- `headers` (optional object of string -> string)
- `payload` (optional any JSON)
- `requestCount` (positive int, bounded by env)
- `concurrency` (positive int, bounded by env)

Responses:
- `202`: test created + queued.
- `200`: duplicate submission detected inside 60-second idempotency window.
- `400`: validation error.
- `429`: rate limit exceeded.
- `500`: server error.

### `GET /tests/:id`

Responses:
- `404` if test does not exist.
- Running/pending payload with progress.
- Completed payload with computed metrics.

### `GET /tests`

Lists tests with computed summary fields.

Optional query filters:
- `method`, `url`
- `minErrorRate`, `maxErrorRate`
- `minThroughput`, `maxThroughput`

## 7) Data model and persistence

Schema is created by `src/infra/db.ts` on startup (no external migration tool).

### `tests` table

Stores:
- test configuration (`url`, `method`, `headers`, `payload`, `request_count`, `concurrency`)
- lifecycle (`status`, `created_at`, `completed_at`)
- tracing (`trace_id`)
- recovery checkpoints (`last_checkpoint_at`, `completed_requests`)

### `metrics` table

Stores one row per executed request:
- status code
- response duration
- success flag
- error message
- timestamp

### Redis keys used

- Fingerprint idempotency key:
  - value = `testId`
  - TTL = 60 seconds
- Progress key:
  - key format = `test:<id>:progress`
  - value = JSON `{ completedRequests, failedRequests }`
  - TTL = 3600 seconds
- Recovery leader lock:
  - key = `loadtest:recovery:leader`
  - prevents multiple workers performing recovery at once

## 8) Worker execution and checkpoint/recovery logic

### Worker concurrency layers

There are two concurrency levels:

1. **BullMQ worker concurrency** (`WORKER_CONCURRENCY`)
   - How many different tests one worker process can execute simultaneously.

2. **Per-test request concurrency** (`test.concurrency`)
   - How many in-flight outbound HTTP requests each test attempts at once.

### Checkpointing

During execution the worker periodically:
- writes metric slices to DB,
- updates Redis progress state,
- updates DB checkpoint columns.

This supports restart/resume behavior.

### Startup recovery

`src/utils/recovery.ts` tries to requeue orphaned `RUNNING` tests when:
- this worker acquires leader lock, and
- queue has no active/waiting jobs.

## 9) Validation, rate limiting, retries, and error handling

### Validation

`LoadTestSchema` enforces:
- URL format,
- method allowlist,
- integer positivity,
- max limits from env:
  - `LOADTEST_MAX_REQUEST_COUNT`
  - `LOADTEST_MAX_CONCURRENCY`

### Rate limiting

All `/tests` routes are limited to **5 requests/min**:
- keyed by `x-user-id` header when present,
- otherwise by client IP.

### HTTP retries for load requests

`axios-retry` config:
- retries: 2
- delay: exponential backoff
- request timeout: 10 seconds

### Error response shape

The API uses a shared helper to return:
- `{ "error": "<message>" }`

## 10) Environment variables

Current expected `.env` values:

- `PORT`: API port (default 3000)
- `REDIS_HOST`, `REDIS_PORT`
- `DATABASE_URL` (preferred single DSN)  
  or
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `WORKER_CONCURRENCY`
- `LOADTEST_MAX_REQUEST_COUNT`
- `LOADTEST_MAX_CONCURRENCY`

## 11) Build, run, and containers

From `package.json`:

- `npm run dev` -> starts API with `ts-node` + nodemon.
- `npm run build` -> compiles TypeScript to `dist`.
- `npm run start` -> starts compiled API.
- `npm run worker` -> starts compiled worker.

Typical local flow:
1. Start Redis + Postgres (or use Docker Compose).
2. `npm run build`
3. Terminal A: `npm run start`
4. Terminal B: `npm run worker`

Docker flow:
- `docker compose up --build`

## 12) Operational behavior notes

- API and worker both initialize DB/Redis on boot.
- Graceful shutdown handlers close queue/redis/db resources.
- `/health` is suitable for basic liveness checks.
- Metrics are aggregated at read-time, not precomputed.

## 13) Known limitations and risks

Important code-level observations:

- In `src/workers/worker.ts`, in-flight promise tracking uses:
  - `await Promise.race(inFlight);`
  - `inFlight = inFlight.filter(Boolean);`
  This does not remove settled promises and can drift from intended per-test concurrency control.

- Recovery enqueues jobs with name `'load-test'`, while normal enqueue uses `'runTest'`.
  - In current setup the worker still processes jobs, but naming mismatch can confuse maintenance and observability.

- `metrics.test_id` currently has no explicit FK/index in bootstrap schema.
  - Could cause slower queries and allow orphan metric rows.

- No automated unit/integration tests are present yet.
  - Core behavior (checkpointing/recovery/staleness) is currently only runtime-validated.

- URL input is broadly open.
  - Production hardening should include SSRF protections and target allowlist/denylist policies.

## 14) Practical mental model (quick)

If you remember only one thing:

- `POST /tests` stores intent + queues work.
- Worker does the heavy lifting and writes metrics.
- `GET /tests/:id` computes and serves progress/results.

That mental model maps directly to the primary files:
- `src/api/controllers/testsController.ts`
- `src/queue/testQueue.ts`
- `src/workers/worker.ts`

## 15) Suggestions for next improvements

Priority improvements worth implementing next:

1. Add automated tests for controller validation and worker checkpoint/recovery.
2. Fix per-test in-flight promise bookkeeping.
3. Add DB index on `metrics(test_id)` and consider FK constraint.
4. Standardize queue job naming.
5. Introduce auth + stronger tenant-aware throttling.
6. Add structured logging + metrics export (queue depth, failures, latency percentiles).

---

If you want, I can also generate a second companion doc with sequence diagrams and "request timeline" visuals for each endpoint/worker phase.
