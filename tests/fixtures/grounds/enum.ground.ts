export function ground(realm: typeof globalThis) {
  "use isolated";
  enum Mode { Strict }
  return { allow: { Math: realm.Math }, deny: Mode.Strict === 0 ? [] : [] };
}
