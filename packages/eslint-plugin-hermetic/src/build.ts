import type { SourceMap } from "./mapped.ts";
import { unlift } from "./unlift.ts";

export type { SourceMap } from "./mapped.ts";
export { unlift, type UnliftOptions, type UnliftResult } from "./unlift.ts";

export interface UnliftPluginOptions {
  /** The modules to unlift, by id. Default: JavaScript and TypeScript modules. */
  readonly include?: RegExp;
  /** The modules to leave as they are, by id. Default: anything in node_modules. */
  readonly exclude?: RegExp;
}

/** What a bundler sees of the context a transform runs in. */
interface TransformContext {
  warn(message: string): void;
}

/**
 * A plugin for Vite, which fits Rolldown and Rollup too. It is typed by its
 * shape, so that it depends on none of them.
 */
export interface UnliftPlugin {
  readonly name: "hermetic-unlift";
  readonly enforce: "pre";
  readonly apply: "build";
  readonly transform: {
    readonly filter: { readonly id: { readonly include: RegExp; readonly exclude: RegExp }; readonly code: string };
    handler(this: TransformContext, code: string, id: string): { code: string; map: SourceMap } | null;
  };
}

const DIRECTIVE = "use hermetic";

/**
 * Unlifts each module as the build reads it, so that production code runs the
 * functions `prefer-hermetic` lifted as they were before the lift, while the
 * source stays hermetic. It runs before the other transforms, on the source as
 * written, and only in builds: the dev server and tests run the lifted source.
 * A binding it can't unlift exactly stays lifted, with a warning that says why.
 */
export function unliftPlugin(options: UnliftPluginOptions = {}): UnliftPlugin {
  const include = options.include ?? /\.[cm]?[jt]sx?$/;
  const exclude = options.exclude ?? /\/node_modules\//;
  return {
    name: "hermetic-unlift",
    enforce: "pre",
    apply: "build",
    transform: {
      // Bundlers that read the filter skip other modules without calling the handler.
      filter: { id: { include, exclude }, code: DIRECTIVE },
      handler(code, id) {
        const path = id.replaceAll("\\", "/");
        if (!matches(include, path) || matches(exclude, path) || !code.includes(DIRECTIVE)) return null;
        const result = unlift(code, id, { sourceMap: true });
        for (const { name, line, reason } of result.skipped) this.warn(`'${name}' on line ${line} stays lifted: ${reason}.`);
        return result.unlifted.length > 0 && result.map ? { code: result.code, map: result.map } : null;
      },
    },
  };
}

/** Tests `path` against a pattern the way a bundler's filter does: on forward slashes, from the start each time. */
function matches(pattern: RegExp, path: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(path);
}
