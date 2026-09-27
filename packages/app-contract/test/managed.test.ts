import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  DEPLOY_WORKFLOW_PATH,
  isManagedPath,
  MANAGED_PATHS,
  renderDeployWorkflow,
  renderPlatformJson,
} from '../src/managed';
import { CONTRACT_VERSION } from '../src/version';

const workflow = parse(renderDeployWorkflow({ apiOrigin: 'https://api.example' })) as {
  on: Record<string, { branches?: string[]; inputs?: Record<string, { required: boolean }> }>;
  concurrency: { group: string; 'cancel-in-progress': boolean };
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: { deploy: { 'timeout-minutes': number; steps: { uses?: string; name?: string; run?: string; if?: string }[] } };
};
const steps = workflow.jobs.deploy.steps;

describe('managed files (CON-1.1, SRC-2.4)', () => {
  it('are exactly platform.json and the deploy workflow', () => {
    expect(MANAGED_PATHS).toEqual(['platform.json', '.github/workflows/deploy.yml']);
    expect(DEPLOY_WORKFLOW_PATH).toBe('.github/workflows/deploy.yml');
  });

  it('protects platform.json and everything under .github/', () => {
    for (const path of ['platform.json', '.github/workflows/deploy.yml', '.github/anything'])
      expect(isManagedPath(path)).toBe(true);
    for (const path of ['src/platform.json', 'github/x', 'package.json']) expect(isManagedPath(path)).toBe(false);
  });

  it('platform.json records the contract version, app and API origin', () => {
    expect(JSON.parse(renderPlatformJson({ slug: 'todo', apiOrigin: 'https://api.example' }))).toEqual({
      contract_version: CONTRACT_VERSION,
      app: 'todo',
      api: 'https://api.example',
    });
  });
});

describe('managed deploy workflow (DEP-1)', () => {
  it('triggers on push to main and on dispatch with a required deployment_id (DEP-1.1)', () => {
    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(workflow.on.workflow_dispatch?.inputs?.deployment_id?.required).toBe(true);
  });

  it('cancels superseded runs, has only OIDC + read permissions and a 10 minute timeout (DEP-1.2)', () => {
    expect(workflow.concurrency).toEqual({ group: 'deploy', 'cancel-in-progress': true });
    expect(workflow.permissions).toEqual({ 'id-token': 'write', contents: 'read' });
    expect(workflow.jobs.deploy['timeout-minutes']).toBe(10);
    expect(workflow.env.API).toBe('https://api.example');
  });

  it('runs the steps in order: start → validate → install → typecheck → build → package → upload (DEP-1.3)', () => {
    expect(steps.filter((s) => s.name && s.name !== 'report failure').map((s) => s.name)).toEqual([
      'start',
      'validate',
      'install',
      'typecheck',
      'build',
      'package',
      'upload',
    ]);
    expect(steps.find((s) => s.name === 'validate')?.run).toContain('/v1/contract/validator/');
  });

  it('reports failures with the step and violations or the log tail (DEP-1.4)', () => {
    const report = steps.find((s) => s.name === 'report failure');
    expect(report?.if).toContain('failure()');
    expect(report?.run).toContain('/fail');
    expect(report?.run).toContain('tail -n 200');
    expect(report?.run).toContain('violations');
  });

  it('authenticates every callback with a fresh OIDC token for the API audience (DEP-1.5)', () => {
    const script = renderDeployWorkflow({ apiOrigin: 'https://api.example' });
    expect(script).toContain('audience=$API');
    expect(script.match(/Bearer \$\(oidc\)/g)).toHaveLength(3);
  });

  it('pins actions by commit SHA and references no secrets (DEP-1.6)', () => {
    for (const step of steps.filter((s) => s.uses)) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(renderDeployWorkflow({ apiOrigin: 'x' })).not.toMatch(/secrets\./);
  });

  it('packages dist, migrations and a manifest (DEP-1.7)', () => {
    const packaging = steps.find((s) => s.name === 'package')?.run ?? '';
    expect(packaging).toContain('tar czf /tmp/artifact.tgz dist migrations manifest.json');
    expect(packaging).toContain('commit_sha');
    expect(packaging).toContain('contract_version');
  });
});
