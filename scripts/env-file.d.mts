export function envFilePath(env: 'dev' | 'prod', root?: string): string;
export function readEnvFile(env: 'dev' | 'prod', root?: string): Record<string, string>;
