-- Build (double4) and deploy (double5) duration percentiles in ms for successful deployments, last 7 days.
SELECT quantileExactWeighted(0.5)(double4, _sample_interval) AS build_p50_ms,
       quantileExactWeighted(0.95)(double4, _sample_interval) AS build_p95_ms,
       quantileExactWeighted(0.5)(double5, _sample_interval) AS deploy_p50_ms,
       quantileExactWeighted(0.95)(double5, _sample_interval) AS deploy_p95_ms
FROM platform_metrics_prod
WHERE blob1 = 'deployment_finished' AND blob2 = 'succeeded' AND timestamp > NOW() - INTERVAL '7' DAY;
