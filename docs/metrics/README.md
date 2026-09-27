# Metric queries (spec 05)

Analytics Engine SQL for the `platform_metrics_<env>` dataset. Run them with the SQL API:

```
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" --data-binary @docs/metrics/<file>.sql
```

The token needs *Account Analytics: Read*. The queries use `platform_metrics_prod`; replace it with `platform_metrics_dev` for dev. Always weight by `_sample_interval` (Analytics Engine samples at high volume). The slot layout is in `specs/05-event-tracking-and-metrics/design.md`.
