import { Queue } from 'bullmq';
import { getRedis } from '../infra/redis';

let _queue: Queue | null = null;

export function getTestQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('loadTests', { connection: getRedis() });
  }
  return _queue;
}

export const addTestToQueue = async (jobData: any) => {
  await getTestQueue().add('runTest', jobData);
};