import { purgeStaleHeartbeats } from '../models/clientHeartbeat.model.js';
import { createPeriodicCleanup } from '../utils/cleanupScheduler.js';

const STALE_MINUTES = 10;

const heartbeatCleanupTask = createPeriodicCleanup(() => purgeStaleHeartbeats(STALE_MINUTES), 'Heartbeat cleanup', 1);

function startHeartbeatCleanup() {
  heartbeatCleanupTask.start();
}

export { startHeartbeatCleanup };
