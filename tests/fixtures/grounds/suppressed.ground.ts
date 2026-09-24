const extra = { fetch: 1 };

export function ground(realm: typeof globalThis) {
  "use isolated";
  // eslint-disable-next-line isolated/closed
  return { allow: { ...extra, Math: realm.Math } };
}
