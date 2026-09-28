import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createPlatform } from '../platform';
import { stepBody } from '../workflows/step-errors';
import { type DeployParams, runDeployment } from './deploy';

/** Durable deploy with per-step retries; non-retryable platform errors fail fast (spec 08 design). */
export class DeployApp extends WorkflowEntrypoint<Env, DeployParams> {
  override async run(event: WorkflowEvent<DeployParams>, step: WorkflowStep): Promise<void> {
    const platform = createPlatform(this.env);
    const deps = {
      db: platform.db,
      cloudflare: platform.cloudflare,
      routes: platform.routes,
      artifacts: this.env.ARTIFACTS,
      clock: platform.clock,
      logger: platform.logger,
      metrics: platform.metrics,
      environment: platform.environment,
    };
    await runDeployment(deps, event.payload, async (name, run) => {
      await step.do(
        name,
        { retries: { limit: 5, delay: '2 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
        stepBody(run),
      );
    });
  }
}
