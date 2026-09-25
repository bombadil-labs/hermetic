export function ground() {
  "use hermetic";
  return { allow: ["Math"].length > 0 ? null : {} };
}
