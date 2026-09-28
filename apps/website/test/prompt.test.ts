import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/web/prompt';

describe('buildPrompt (WEB-1.6)', () => {
  const base = {
    description: '  A shared shopping list for my family.\nAnyone can add items.  ',
    connectorName: 'AI App Hosting (dev)',
  };

  it('includes the description verbatim (trimmed), the connector and the workflow', () => {
    const prompt = buildPrompt({ ...base, audience: 'me' });
    expect(prompt).toContain('"AI App Hosting (dev)" connector');
    expect(prompt).toContain('What the app should do:\nA shared shopping list for my family.\nAnyone can add items.\n');
    for (const text of [
      'ask for my email, then for the 6-digit code',
      'read the platform guide (all topics)',
      "deploy it and follow the build until it's live",
      'give me the link',
      "I'm not technical",
    ]) {
      expect(prompt).toContain(text);
    }
  });

  it('turns the audience into sign-in requirements', () => {
    expect(buildPrompt({ ...base, audience: 'me' })).toContain('Only me. Keep it private');
    const many = buildPrompt({ ...base, audience: 'many' });
    expect(many).toContain('Several people. Let people sign up and sign in with their email address');
    expect(many).toContain('Each person should only see their own data');
  });
});
