const makeGround = (realm: typeof globalThis) => {
  "use isolated";
  return { allow: { Array: realm.Array }, deny: [] };
};

export { makeGround as ground };
