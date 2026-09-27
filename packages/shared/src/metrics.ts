import type { Logger } from './logger';

/** The parts of Analytics Engine's types we use (structural, so non-worker packages can compile this). */
export type MetricDataPoint = { indexes: string[]; blobs: string[]; doubles: number[] };
export type MetricDataset = { writeDataPoint(point: MetricDataPoint): void };

/** Analytics Engine event names (spec 05 design). */
export type MetricEvent =
  | 'tool_call'
  | 'session_init'
  | 'login_code_requested'
  | 'login_succeeded'
  | 'login_failed'
  | 'app_created'
  | 'app_deleted'
  | 'provisioning_failed'
  | 'deployment_finished'
  | 'email_sent'
  | 'email_rejected'
  | 'email_bounced'
  | 'email_complained'
  | 'event_emit_failed'
  | 'usage_collected'
  | 'usage_collection_failed';

export type MetricFields = {
  orgId?: string | null | undefined;
  sub?: string | null | undefined;
  outcome?: 'ok' | 'error' | null | undefined;
  errorCode?: string | null | undefined;
  clientName?: string | null | undefined;
  clientVersion?: string | null | undefined;
  appId?: string | null | undefined;
  userId?: string | null | undefined;
  durationMs?: number | null | undefined;
  bytes?: number | null | undefined;
  phase1Ms?: number | null | undefined;
  phase2Ms?: number | null | undefined;
};

export interface Metrics {
  write(event: MetricEvent, fields?: MetricFields): void;
}

/** The Analytics Engine data point for an event — the one place that knows the slot layout (EVT-2.6). */
export function toDataPoint(event: MetricEvent, f: MetricFields = {}): MetricDataPoint {
  return {
    indexes: [f.orgId || 'anon'],
    blobs: [
      event,
      f.sub ?? '',
      f.outcome ?? '',
      f.errorCode ?? '',
      f.clientName ?? '',
      f.clientVersion ?? '',
      f.appId ?? '',
      f.userId ?? '',
    ],
    doubles: [1, f.durationMs ?? 0, f.bytes ?? 0, f.phase1Ms ?? 0, f.phase2Ms ?? 0],
  };
}

/** Writes to the METRICS dataset; never throws (EVT-2.7). A missing binding is logged once and ignored. */
export function createMetrics(dataset: MetricDataset | undefined, logger: Logger): Metrics {
  let warned = false;
  return {
    write(event, fields) {
      try {
        if (!dataset) {
          if (!warned) logger.warn('METRICS binding missing; metrics are not written', { event });
          warned = true;
          return;
        }
        dataset.writeDataPoint(toDataPoint(event, fields));
      } catch (error) {
        logger.error('metrics write failed', { event, error });
      }
    },
  };
}

/** Collects data points in memory (tests). */
export function memoryMetrics(): Metrics & { points: { event: MetricEvent; fields: MetricFields }[] } {
  const points: { event: MetricEvent; fields: MetricFields }[] = [];
  return { points, write: (event, fields = {}) => void points.push({ event, fields }) };
}
