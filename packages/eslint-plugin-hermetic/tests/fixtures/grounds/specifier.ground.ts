const makeGround = (realm: typeof globalThis) => {
  "use hermetic";
  return { allow: { Array: realm.Array }, deny: [] };
};

export { makeGround as ground };
