/** KV route per app slug, read by the dispatcher (spec 09). */
export type AppRoute = { appId: string; scriptName: string; state: 'live' | 'not_deployed' };

export type RouteStore = Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>;

export const putRoute = (kv: RouteStore, slug: string, route: AppRoute) => kv.put(slug, JSON.stringify(route));
export const getRoute = (kv: RouteStore, slug: string) => kv.get<AppRoute>(slug, 'json');
export const deleteRoute = (kv: RouteStore, slug: string) => kv.delete(slug);
