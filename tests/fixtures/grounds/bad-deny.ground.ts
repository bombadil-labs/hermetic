export function ground(realm: typeof globalThis) {
  "use hermetic";
  return { allow: { Math: realm.Math }, deny: ["Math..random"] };
}
