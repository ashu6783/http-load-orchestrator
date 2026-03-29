import { getDb } from '../infra/db';
import { getTestQueue } from '../queue/testQueue';
import { getRedis } from '../infra/redis';

const LOCK_KEY = 'loadtest:recovery:leader';
const LOCK_TTL_SECONDS = 30;

export async function acquireLeaderLock(): Promise<boolean> {
  const redis = getRedis();

  // Using redis.call due to TS error which is an edge case in prod repos
  const result = await redis.call(
    'SET',
    LOCK_KEY,
    process.pid.toString(),
    'EX',
    LOCK_TTL_SECONDS,
    'NX'
  );

  return result === 'OK';
}



/**
 * Requeues tests stuck in RUNNING state.
 * This runs only when:
 * 1. This worker acquires the leader lock
 * 2. The queue is completely idle
 */
export async function recoverOrphanedTestsIfSafe(): Promise<void> {
  const isLeader = await acquireLeaderLock();
  if (!isLeader) return;

  const counts = await getTestQueue().getJobCounts();

  // Do NOT recover if queue is active
  if (counts.waiting > 0 || counts.active > 0) {
    return;
  }

  const db = getDb();

  const { rows } = await db.query("SELECT id FROM tests WHERE status = 'RUNNING'");
  const orphanedTests = rows as { id: string }[];

  for (const t of orphanedTests) {
        await getTestQueue().add('load-test', { testId: t.id });
  }
}
