#!/usr/bin/env node
// Monthly usage and estimated cost per org and app (spec 13, USG-2.2).
// Usage: node scripts/usage-report.mjs <dev|prod> [--month YYYY-MM] [--org <org_id>]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../packages/app-contract/src/jsonc.ts';
import { estimateCostUsd } from '../packages/shared/src/pricing.ts';
import { readEnvFile } from './env-file.mjs';

const daysIn = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Rows of { org_id, org_slug, app_id, app_slug, metric, quantity } → apps sorted by cost, with org totals. */
export function buildReport(rows, month) {
  const apps = new Map();
  for (const row of rows) {
    const app = apps.get(row.app_id) ?? { orgId: row.org_id, org: row.org_slug, app: row.app_slug, totals: {} };
    app.totals[row.metric] = (app.totals[row.metric] ?? 0) + Number(row.quantity);
    apps.set(row.app_id, app);
  }
  const days = daysIn(month);
  const list = [...apps.values()].map((a) => ({ ...a, costUsd: estimateCostUsd(a.totals, days) }));
  list.sort((a, b) => b.costUsd - a.costUsd);
  const orgs = new Map();
  for (const a of list) orgs.set(a.orgId, { org: a.org, costUsd: (orgs.get(a.orgId)?.costUsd ?? 0) + a.costUsd });
  return {
    apps: list,
    orgs: [...orgs.values()].sort((a, b) => b.costUsd - a.costUsd),
    totalUsd: list.reduce((s, a) => s + a.costUsd, 0),
  };
}

export function reportSql(month, orgId) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('--month must be YYYY-MM');
  if (orgId !== undefined && !/^org_[A-Za-z0-9_-]{11}$/.test(orgId)) throw new Error('--org must be an org id');
  return `SELECT u.org_id, o.slug AS org_slug, u.app_id, a.slug AS app_slug, u.metric, SUM(u.quantity) AS quantity
    FROM app_usage_daily u JOIN apps a ON a.id = u.app_id JOIN organizations o ON o.id = u.org_id
    WHERE u.day LIKE '${month}-%'${orgId ? ` AND u.org_id = '${orgId}'` : ''}
    GROUP BY u.org_id, u.app_id, u.metric`;
}

const fmt = (n) => (n >= 1000 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [env, ...rest] = process.argv.slice(2);
  if (env !== 'dev' && env !== 'prod') {
    process.stderr.write('usage: node scripts/usage-report.mjs <dev|prod> [--month YYYY-MM] [--org <org_id>]\n');
    process.exit(2);
  }
  const flag = (name) => rest[rest.indexOf(name) + 1];
  const month = rest.includes('--month') ? flag('--month') : new Date().toISOString().slice(0, 7);
  const orgId = rest.includes('--org') ? flag('--org') : undefined;
  const config = parseJsonc(readFileSync('apps/api/wrangler.jsonc', 'utf8'));
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/d1/database/${config.env[env].d1_databases[0].database_id}/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${readEnvFile(env).CF_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: reportSql(month, orgId) }),
    },
  );
  const json = await res.json();
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  const report = buildReport(json.result[0].results, month);
  const out = (line) => process.stdout.write(`${line}\n`);
  out(`Usage ${env} ${month} — estimated total $${report.totalUsd.toFixed(4)} (list prices, allowances ignored)`);
  out('');
  out(['cost $', 'org', 'app', 'requests', 'cpu ms', 'd1 read', 'd1 written', 'emails', 'build min'].join('\t'));
  for (const a of report.apps) {
    const t = a.totals;
    out(
      [
        a.costUsd.toFixed(4),
        a.org,
        a.app,
        fmt(t.requests ?? 0),
        fmt(t.cpu_ms ?? 0),
        fmt(t.d1_rows_read ?? 0),
        fmt(t.d1_rows_written ?? 0),
        fmt(t.emails ?? 0),
        fmt((t.build_ms ?? 0) / 60_000),
      ].join('\t'),
    );
  }
  out('');
  for (const o of report.orgs) out(`org ${o.org}: $${o.costUsd.toFixed(4)}`);
}
