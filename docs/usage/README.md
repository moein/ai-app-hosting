# Usage queries (spec 13)

Per-app daily usage lives in the platform D1 table `app_usage_daily` (`app_id`, `org_id`, `day`, `metric`, `quantity`). Metric names and units: `packages/shared/src/usage.ts`; prices: `packages/shared/src/pricing.ts`.

Monthly report with estimated cost: `node scripts/usage-report.mjs <env> [--month YYYY-MM] [--org <org_id>]`.

Ad-hoc SQL (`wrangler d1 execute platform-db-<env> --env <env> --remote --command "…"`):

```sql
-- Top apps by requests this month
SELECT a.slug, SUM(u.quantity) AS requests
FROM app_usage_daily u JOIN apps a ON a.id = u.app_id
WHERE u.metric = 'requests' AND u.day >= strftime('%Y-%m-01', 'now')
GROUP BY u.app_id ORDER BY requests DESC LIMIT 20;

-- One app, day by day, every metric
SELECT day, metric, quantity FROM app_usage_daily
WHERE app_id = ? ORDER BY day DESC, metric;

-- Org totals per metric this month
SELECT org_id, metric, SUM(quantity) AS total
FROM app_usage_daily WHERE day >= strftime('%Y-%m-01', 'now')
GROUP BY org_id, metric ORDER BY org_id, metric;
```
