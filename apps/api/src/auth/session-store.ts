import type { OrgId, UserId } from '@repo/shared';

export type SessionAuth = { userId: UserId; orgId: OrgId; authenticatedAt: number; lastSeenAt: number };

/** Per-MCP-session data (spec 02 design). Backed by the session Durable Object's storage. */
export interface SessionStore {
  getAuth(): Promise<SessionAuth | null>;
  setAuth(auth: SessionAuth): Promise<void>;
  clearAuth(): Promise<void>;
  /** Timestamps of login-code sends strictly after `since`; older ones are dropped. */
  recentLoginCodeRequests(since: number): Promise<number[]>;
  recordLoginCodeRequest(at: number): Promise<void>;
}

type KeyValue = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};

const AUTH = 'auth';
const LOGIN_CODE_REQUESTS = 'loginCodeRequests';

export function createSessionStore(storage: KeyValue): SessionStore {
  return {
    getAuth: async () => (await storage.get<SessionAuth>(AUTH)) ?? null,
    setAuth: (auth) => storage.put(AUTH, auth),
    clearAuth: async () => {
      await storage.delete(AUTH);
    },
    async recentLoginCodeRequests(since) {
      const recent = ((await storage.get<number[]>(LOGIN_CODE_REQUESTS)) ?? []).filter((at) => at > since);
      await storage.put(LOGIN_CODE_REQUESTS, recent);
      return recent;
    },
    async recordLoginCodeRequest(at) {
      await storage.put(LOGIN_CODE_REQUESTS, [...((await storage.get<number[]>(LOGIN_CODE_REQUESTS)) ?? []), at]);
    },
  };
}

/** In-memory storage with the same API, for tests. */
export function memoryStorage(): KeyValue {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: async (key) => map.delete(key),
  };
}
