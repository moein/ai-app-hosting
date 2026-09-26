import { nanoid } from 'nanoid';

export const ID_PREFIXES = ['usr', 'org', 'app', 'dep', 'evt', 'lc'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

declare const idBrand: unique symbol;
export type Id<P extends IdPrefix> = `${P}_${string}` & { readonly [idBrand]: P };

export type UserId = Id<'usr'>;
export type OrgId = Id<'org'>;
export type AppId = Id<'app'>;
export type DeploymentId = Id<'dep'>;
export type EventId = Id<'evt'>;
export type LoginCodeId = Id<'lc'>;

export const ID_BODY_LENGTH = 11;
const ID_BODY = /^[A-Za-z0-9_-]{11}$/;

/** The only way to create entity IDs (FND-3.2): `<prefix>_<nanoid(11)>`. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${nanoid(ID_BODY_LENGTH)}` as Id<P>;
}

export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is Id<P> {
  if (typeof value !== 'string') return false;
  const head = `${prefix}_`;
  return value.startsWith(head) && ID_BODY.test(value.slice(head.length));
}
