import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createPlatform, provisionDeps } from '../platform';
import { runProvisioning } from './provision';

export type ProvisionParams = { appId: string };

/** Durable app provisioning with per-step retries (APP-2.3, spec 03 design). */
export class ProvisionApp extends WorkflowEntrypoint<Env, ProvisionParams> {
  override async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep): Promise<void> {
    const deps = provisionDeps(createPlatform(this.env));
    await runProvisioning(deps, event.payload.appId, async (name, run) => {
      await step.do(
        name,
        { retries: { limit: 5, delay: '2 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
        run,
      );
    });
  }
}
