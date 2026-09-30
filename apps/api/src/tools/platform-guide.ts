import { CONTRACT_VERSION, GUIDE_TOPICS, type GuideTopic, renderGuide } from '@repo/app-contract';
import { z } from 'zod';
import { defineTool } from '../mcp/tool';

const TOPICS = ['all', ...GUIDE_TOPICS] as ['all', ...GuideTopic[]];

export const getPlatformGuide = defineTool({
  name: 'get_platform_guide',
  title: 'Read the platform guide',
  description:
    'How to build and ship an app on this platform: the workflow, the exact app contract (files, wrangler.jsonc, dependencies, rules), database, file storage, email, secrets, limits and troubleshooting. You write all of the app\'s code, so read this (topic "all") before writing any file.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z.enum(TOPICS).default('all').describe('One section of the guide, or "all" (default) for everything.'),
  }),
  output: z.object({
    contract_version: z.string(),
    topic: z.enum(TOPICS),
    markdown: z.string(),
  }),
  handler: async ({ topic }, ctx) => ({
    contract_version: CONTRACT_VERSION,
    topic,
    markdown: renderGuide(topic, { appsDomain: ctx.env.APPS_DOMAIN }),
  }),
});
