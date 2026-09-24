export default function (realm: typeof globalThis) {
  "use hermetic";
  return { allow: { JSON: realm.JSON } };
}
