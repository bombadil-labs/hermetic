/** @isolated */
export const ground = (realm: typeof globalThis) => ({ allow: { Map: realm.Map } });
