export async function ground(realm: typeof globalThis) {
  "use isolated";
  return { allow: { Math: realm.Math } };
}
