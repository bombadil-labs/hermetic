export default function (realm: typeof globalThis) {
  "use isolated";
  return { allow: { JSON: realm.JSON } };
}
