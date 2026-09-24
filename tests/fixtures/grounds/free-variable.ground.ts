const extra = { fetch: 1 };

export function ground(realm: typeof globalThis) {
  "use isolated";
  return { allow: { ...extra, Math: realm.Math } };
}
