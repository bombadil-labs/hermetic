export function ground(realm: typeof globalThis) {
  "use hermetic";
  enum Mode { Strict }
  return { allow: { Math: realm.Math }, deny: Mode.Strict === 0 ? [] : [] };
}
