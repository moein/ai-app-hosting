-- Signups and sign-ins per day, last 30 days.
SELECT toStartOfDay(timestamp) AS day,
       SUM(IF(blob2 = 'signup', _sample_interval * double1, 0)) AS signups,
       SUM(IF(blob2 = 'signin', _sample_interval * double1, 0)) AS signins
FROM platform_metrics_prod
WHERE blob1 = 'login_succeeded' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day
ORDER BY day;
