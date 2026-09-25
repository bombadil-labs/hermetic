const extra = { fetch: 1 };

export function ground(realm: typeof globalThis) {
  "use hermetic";
  return { allow: { ...extra, Math: realm.Math } };
}
