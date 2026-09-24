export function ground(realm) {
  "use hermetic";
  return { allow: { Math: realm.Math, Set: realm.Set }, deny: ["Math.random"] };
}
