export function ground(realm) {
  "use isolated";
  return { allow: { Math: realm.Math, Set: realm.Set }, deny: ["Math.random"] };
}
