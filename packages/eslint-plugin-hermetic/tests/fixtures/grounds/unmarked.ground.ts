export function ground(realm: typeof globalThis) {
  return { allow: { Math: realm.Math } };
}
