import { fileURLToPath } from "node:url";

export const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/grounds/${name}`, import.meta.url));

export const repoRoot: string = fileURLToPath(new URL("../", import.meta.url));
