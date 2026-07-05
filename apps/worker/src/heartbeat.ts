/** Worker heartbeat payload written to Redis and logged on every beat. */

export const HEARTBEAT_JOB_NAME = 'system.heartbeat';
export const HEARTBEAT_REDIS_KEY = 'spectra:worker:heartbeat';
/** TTL keeps stale heartbeats from lingering after a crash. */
export const HEARTBEAT_TTL_SECONDS = 180;

export interface HeartbeatPayload {
  service: 'worker';
  pid: number;
  hostname: string;
  startedAt: string;
  at: string;
  uptimeSeconds: number;
}

export interface HeartbeatInputs {
  pid: number;
  hostname: string;
  startedAt: Date;
  now: Date;
}

export function buildHeartbeat(inputs: HeartbeatInputs): HeartbeatPayload {
  const uptimeMs = inputs.now.getTime() - inputs.startedAt.getTime();
  return {
    service: 'worker',
    pid: inputs.pid,
    hostname: inputs.hostname,
    startedAt: inputs.startedAt.toISOString(),
    at: inputs.now.toISOString(),
    uptimeSeconds: Math.max(0, Math.round(uptimeMs / 1000)),
  };
}
