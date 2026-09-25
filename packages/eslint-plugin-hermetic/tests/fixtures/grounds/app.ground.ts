// A ground with a host-provided global.
export function ground(realm: typeof globalThis & { __DEV__?: boolean }) {
  "use hermetic";
  return { allow: { __DEV__: realm.__DEV__, JSON: realm.JSON } };
}
