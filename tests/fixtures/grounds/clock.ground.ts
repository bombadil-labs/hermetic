// Allows Date but not the clock, and denies a nested path.
export function ground(realm: typeof globalThis) {
  "use isolated";
  return {
    allow: { Math: realm.Math, Date: realm.Date, Object: realm.Object },
    deny: ["Math.random", "Date.now", "Object.prototype.toString"],
  };
}
