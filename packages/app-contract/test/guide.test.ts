import { readFileSync } from 'node:fs';
import { APP_EMAIL_ERROR_CODES } from '@repo/shared';
import * as limits from '@repo/shared/limits';
import { describe, expect, it } from 'vitest';
import { generateGuideModule, OUTPUT, TOPIC_ORDER } from '../scripts/build-guide.mjs';
import { formatBytes, GUIDE_TOPICS, renderGuide } from '../src/guide';
import { RULES } from '../src/rules';
import { CONTRACT_VERSION } from '../src/version';

const render = (topic: Parameters<typeof renderGuide>[0]) => renderGuide(topic, { appsDomain: 'apps.example' });

describe('platform guide (MCP-2, CON-1)', () => {
  it('the generated module is up to date with guide/*.md', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(generateGuideModule());
    expect(GUIDE_TOPICS).toEqual(TOPIC_ORDER);
  });

  it.each(GUIDE_TOPICS)('topic %s renders with every placeholder filled', (topic) => {
    const markdown = render(topic);
    expect(markdown.length).toBeGreaterThan(200);
    expect(markdown).not.toMatch(/\{\{|\}\}/);
  });

  it('"all" joins every topic in order', () => {
    const all = render('all');
    const positions = GUIDE_TOPICS.map((topic) => all.indexOf(render(topic).split('\n')[0] as string));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('interpolates limits from limits.ts (MCP-2.3)', () => {
    expect(render('limits')).toContain(`| Files per \`write_files\` call | ${limits.MAX_FILES_PER_WRITE} |`);
    expect(render('limits')).toContain(formatBytes(limits.MAX_FILE_BYTES));
    expect(render('workflow')).toContain('https://<slug>.apps.example');
  });

  it('documents the EMAIL binding: types, every error code and the limits (MCP-2.2, spec 11)', () => {
    const email = render('email');
    for (const text of ['type AppEmailMessage', 'type AppEmailResult', 'EMAIL: { send(message: AppEmailMessage)']) {
      expect(email).toContain(text);
    }
    for (const code of APP_EMAIL_ERROR_CODES) expect(email).toContain(`'${code}'`);
    expect(email).toContain(`1..${limits.MAX_EMAIL_RECIPIENTS} recipients`);
    expect(email).toContain(`${limits.MAX_EMAILS_PER_ORG_PER_DAY} emails per day`);
    expect(email).toContain(formatBytes(limits.MAX_EMAIL_BYTES));
  });

  it('states that the AI writes every file and there are no templates (MCP-2.4, CON-1.1)', () => {
    const workflow = render('workflow');
    expect(workflow).toContain("You write all of the app's code");
    expect(workflow).toContain('no templates');
  });

  it('the contract lists every rule with its fix and the contract version (CON-1.2, CON-1.3)', () => {
    const contract = render('contract');
    expect(contract).toContain(`version ${CONTRACT_VERSION}`);
    for (const rule of RULES) expect(contract).toContain(`\`${rule.id}\``);
  });

  it('the contract includes the exact wrangler.jsonc and vite.config.ts (CON-1.4)', () => {
    const contract = render('contract');
    expect(contract).toContain('"name": "app"');
    expect(contract).toContain('"run_worker_first": ["/api/*"]');
    expect(contract).toContain('"binding": "DB"');
    expect(contract).toContain('plugins: [react(), cloudflare()]');
  });

  it('formats sizes', () => {
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MiB');
    expect(formatBytes(5_000_000)).toBe('5 MB');
    expect(formatBytes(5_120)).toBe('5 KiB');
    expect(formatBytes(80_000)).toBe('80 KB');
  });
});
