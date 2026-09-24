export function ground() {
  "use isolated";
  return { allow: ["Math"].length > 0 ? null : {} };
}
