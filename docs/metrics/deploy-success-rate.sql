-- Deployment outcomes per day (succeeded / failed / cancelled), last 30 days.
SELECT toStartOfDay(timestamp) AS day, blob2 AS status, SUM(_sample_interval * double1) AS deployments
FROM platform_metrics_prod
WHERE blob1 = 'deployment_finished' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, status
ORDER BY day, status;
