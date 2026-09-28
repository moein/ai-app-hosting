/** The prompt the person pastes into their AI (spec 14, WEB-1.6). Pure. */
export type Audience = 'me' | 'many';

const AUDIENCE: Record<Audience, string> = {
  me: 'Only me. Keep it private: add a sign-in with my email address (a one-time code sent by email) and only let my email in — ask me which email to use.',
  many: 'Several people. Let people sign up and sign in with their email address (a one-time code sent by email). Each person should only see their own data, unless sharing is part of what the app does.',
};

export function buildPrompt(input: { description: string; audience: Audience; connectorName: string }): string {
  return `I want you to build and host a web app for me with the "${input.connectorName}" connector.

What the app should do:
${input.description.trim()}

Who will use it:
${AUDIENCE[input.audience]}

How to do it:
1. Sign me in to the connector: ask for my email, then for the 6-digit code I receive.
2. Before writing any code, read the platform guide (all topics) and follow it exactly.
3. Create the app, write all of its code, deploy it and follow the build until it's live. If anything fails, read the errors and logs, fix it and deploy again.
4. When it works, give me the link and a short, non-technical explanation of how to use it.

I'm not technical: make the technical decisions yourself and only ask me about what the app should do.`;
}
