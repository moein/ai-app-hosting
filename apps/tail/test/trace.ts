/** Builds synthetic TraceItems shaped like what workerd hands a tail consumer. */
export function traceItem(overrides: Partial<Record<keyof TraceItem, unknown>> = {}): TraceItem {
  return {
    event: {
      request: {
        method: 'GET',
        url: 'https://todo.dev.motad.app/api/notes?token=secret#x',
        headers: { cookie: 'session=abc', authorization: 'Bearer t', 'cf-connecting-ip': '1.2.3.4' },
        cf: { clientIp: '1.2.3.4' },
      },
      response: { status: 200 },
    },
    eventTimestamp: 1_790_000_000_000,
    logs: [],
    exceptions: [],
    diagnosticsChannelEvents: [],
    scriptName: 'app-todo-dev',
    scriptTags: ['app_V1StGXR8_Z5', 'org_abcdefghijk'],
    outcome: 'ok',
    executionModel: 'stateless',
    truncated: false,
    cpuTime: 2,
    wallTime: 12.4,
    ...overrides,
  } as unknown as TraceItem;
}
