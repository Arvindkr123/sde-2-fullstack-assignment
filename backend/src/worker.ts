import { Worker } from 'bullmq';
import { bullConnection } from './config/redis';
import { SEND_QUEUE, recoverStuckJobs } from './sequences/scheduler';
import { processSendJob } from './worker/processor';

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const worker = new Worker(SEND_QUEUE, processSendJob, {
  connection: bullConnection,
  concurrency: 4,
});

worker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} ok`);
});

worker.on('failed', (job, err) => {
  console.warn(`[worker] job ${job?.id} failed: ${err.message}`);
});

// On startup: immediately recover any jobs that were stuck in 'processing'
// from a previous crash, then re-run the sweep every 5 minutes.
void recoverStuckJobs();
setInterval(() => void recoverStuckJobs(), RECOVERY_INTERVAL_MS);

console.log('[worker] listening on queue', SEND_QUEUE);
