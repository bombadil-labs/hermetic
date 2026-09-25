// Lints clean (realm.Function is member access on the argument), but the
// linter's realm refuses to compile strings.
export function ground(realm: typeof globalThis) {
  "use hermetic";
  return { allow: { x: realm.Function("return 1")() } };
}
