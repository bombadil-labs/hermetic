const LIMIT = 10;

// Not the bootstrap, so its problems do not block loading.
export function helper(n: number) {
  "use hermetic";
  return n < LIMIT;
}

export function ground(realm: typeof globalThis) {
  "use hermetic";
  return { allow: { String: realm.String } };
}
