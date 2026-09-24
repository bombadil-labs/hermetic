const extra = { fetch: 1 };

export function ground(realm: typeof globalThis) {
  "use hermetic";
  // eslint-disable-next-line hermetic/sealed
  return { allow: { ...extra, Math: realm.Math } };
}
