-- Emails per day: sent (app / platform), rejected (by reason), bounces and complaints, last 30 days.
SELECT toStartOfDay(timestamp) AS day, blob1 AS event, blob2 AS sub, SUM(_sample_interval * double1) AS count
FROM platform_metrics_prod
WHERE blob1 IN ('email_sent', 'email_rejected', 'email_bounced', 'email_complained')
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day, event, sub
ORDER BY day, event, sub;
