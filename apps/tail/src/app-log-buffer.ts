import { DurableObject } from 'cloudflare:workers';
import {
  type AppLogsRpc,
  LOG_BUFFER_MAX_AGE_MS,
  LOG_BUFFER_MAX_ENTRIES,
  LOG_INGEST_MAX_PER_MINUTE,
  type LogEntry,
  type LogFilter,
  type LogPage,
} from '@repo/shared';

const HOUR_MS = 60 * 60 * 1000;
const USAGE_RETENTION_DAYS = 7;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const MINUTE_MS = 60 * 1000;
const LEVEL_RANK_SQL = "CASE level WHEN 'debug' THEN 0 WHEN 'warn' THEN 2 WHEN 'error' THEN 3 ELSE 1 END";
const RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;

type Row = {
  seq: number;
  ts: number;
  kind: LogEntry['kind'];
  level: LogEntry['level'];
  message: string;
  method: string | null;
  path: string | null;
  status: number | null;
  outcome: string | null;
  duration_ms: number | null;
  stack: string | null;
  invocation_id: string;
};

function toEntry(row: Row): LogEntry {
  const entry: LogEntry = {
    ts: row.ts,
    kind: row.kind,
    level: row.level,
    message: row.message,
    invocation_id: row.invocation_id,
  };
  if (row.method !== null) entry.method = row.method;
  if (row.path !== null) entry.path = row.path;
  if (row.status !== null) entry.status = row.status;
  if (row.outcome !== null) entry.outcome = row.outcome;
  if (row.duration_ms !== null) entry.duration_ms = row.duration_ms;
  if (row.stack !== null) entry.stack = row.stack;
  return entry;
}

/** Recent runtime logs of one app (spec 10, LOG-2.5/2.7), keyed by app id. */
export class AppLogBuffer extends DurableObject<Env> implements AppLogsRpc {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.createSchema();
  }

  private createSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL,
        method TEXT, path TEXT, status INTEGER, outcome TEXT, duration_ms INTEGER, stack TEXT,
        invocation_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts DESC);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, entries INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest (minute INTEGER PRIMARY KEY, count INTEGER NOT NULL, dropped INTEGER NOT NULL DEFAULT 0, dropped_seq INTEGER);
    `);
  }

  async append(entries: LogEntry[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const entry of entries) this.ingest(entry);
      const total = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM logs').one().n;
      if (total > LOG_BUFFER_MAX_ENTRIES) {
        this.sql.exec(
          'DELETE FROM logs WHERE seq IN (SELECT seq FROM logs ORDER BY seq ASC LIMIT ?)',
          total - LOG_BUFFER_MAX_ENTRIES,
        );
      }
    });
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }

  private ingest(entry: LogEntry): void {
    const stored = entry.kind !== 'console' || !this.overCap(entry);
    const bytes = stored ? utf8Bytes(entry.message) + utf8Bytes(entry.stack ?? '') : 0;
    this.sql.exec(
      `INSERT INTO usage (day, entries, bytes) VALUES (?, 1, ?)
       ON CONFLICT (day) DO UPDATE SET entries = entries + 1, bytes = bytes + excluded.bytes`,
      new Date(entry.ts).toISOString().slice(0, 10),
      bytes,
    );
    const minute = Math.floor(entry.ts / MINUTE_MS);
    const counter = this.sql
      .exec<{ count: number; dropped: number; dropped_seq: number | null }>(
        'SELECT count, dropped, dropped_seq FROM ingest WHERE minute = ?',
        minute,
      )
      .toArray()[0] ?? { count: 0, dropped: 0, dropped_seq: null };

    if (counter.count >= LOG_INGEST_MAX_PER_MINUTE && entry.kind === 'console') {
      const dropped = counter.dropped + 1;
      const message = `${dropped} console entr${dropped === 1 ? 'y' : 'ies'} dropped: over ${LOG_INGEST_MAX_PER_MINUTE} log entries in this minute.`;
      let droppedSeq = counter.dropped_seq;
      if (droppedSeq === null) {
        droppedSeq = this.insert({
          ts: minute * MINUTE_MS + MINUTE_MS - 1,
          kind: 'dropped',
          level: 'warn',
          message,
          invocation_id: 'dropped',
        });
      } else {
        this.sql.exec('UPDATE logs SET message = ? WHERE seq = ?', message, droppedSeq);
      }
      this.sql.exec('UPDATE ingest SET dropped = ?, dropped_seq = ? WHERE minute = ?', dropped, droppedSeq, minute);
      return;
    }
    this.insert(entry);
    this.sql.exec(
      'INSERT INTO ingest (minute, count) VALUES (?, 1) ON CONFLICT (minute) DO UPDATE SET count = count + 1',
      minute,
    );
  }

  private insert(entry: LogEntry): number {
    return this.sql
      .exec<{ seq: number }>(
        `INSERT INTO logs (ts, kind, level, message, method, path, status, outcome, duration_ms, stack, invocation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
        entry.ts,
        entry.kind,
        entry.level,
        entry.message,
        entry.method ?? null,
        entry.path ?? null,
        entry.status ?? null,
        entry.outcome ?? null,
        entry.duration_ms ?? null,
        entry.stack ?? null,
        entry.invocation_id,
      )
      .one().seq;
  }

  async query(filter: LogFilter): Promise<LogPage> {
    const where = ['ts >= ?', 'ts < ?'];
    const params: (string | number)[] = [filter.since, filter.until];
    if (filter.level) {
      where.push(`${LEVEL_RANK_SQL} >= ?`);
      params.push(RANK[filter.level]);
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.search) {
      where.push("(instr(lower(message), lower(?)) > 0 OR instr(lower(coalesce(path, '')), lower(?)) > 0)");
      params.push(filter.search, filter.search);
    }
    if (filter.status_min !== undefined) {
      where.push("kind = 'request' AND status >= ?");
      params.push(filter.status_min);
    }
    const cursor = /^(\d+)\.(\d+)$/.exec(filter.cursor ?? '');
    if (cursor) {
      where.push('(ts < ? OR (ts = ? AND seq < ?))');
      params.push(Number(cursor[1]), Number(cursor[1]), Number(cursor[2]));
    }
    const rows = this.sql
      .exec<Row>(
        `SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY ts DESC, seq DESC LIMIT ?`,
        ...params,
        filter.limit + 1,
      )
      .toArray();
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    return {
      entries: page.map(toEntry),
      next_cursor: rows.length > filter.limit && last ? `${last.ts}.${last.seq}` : null,
    };
  }

  private overCap(entry: LogEntry): boolean {
    const counter = this.sql
      .exec<{ count: number }>('SELECT count FROM ingest WHERE minute = ?', Math.floor(entry.ts / MINUTE_MS))
      .toArray()[0];
    return (counter?.count ?? 0) >= LOG_INGEST_MAX_PER_MINUTE;
  }

  async usage(days: string[]): Promise<Record<string, { entries: number; bytes: number }>> {
    const result: Record<string, { entries: number; bytes: number }> = {};
    for (const day of days) {
      const row = this.sql
        .exec<{ entries: number; bytes: number }>('SELECT entries, bytes FROM usage WHERE day = ?', day)
        .toArray()[0];
      if (row) result[day] = { entries: row.entries, bytes: row.bytes };
    }
    return result;
  }

  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createSchema(); // deleteAll drops the tables too; this instance keeps serving
  }

  override async alarm(): Promise<void> {
    const cutoff = Date.now() - LOG_BUFFER_MAX_AGE_MS;
    this.sql.exec('DELETE FROM logs WHERE ts < ?', cutoff);
    this.sql.exec('DELETE FROM ingest WHERE minute < ?', Math.floor(cutoff / MINUTE_MS));
    const usageCutoff = new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    this.sql.exec('DELETE FROM usage WHERE day < ?', usageCutoff);
    await this.ctx.storage.setAlarm(Date.now() + HOUR_MS);
  }
}
