import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { analyze, createEnvironment, type HermeticSettings, type MessageIds, SETTINGS_SCHEMA } from "../analysis.ts";
import { type FunctionNode, functionName, isMarkedHermetic } from "../marking.ts";

export type { MessageIds } from "../analysis.ts";

/**
 * Options for `hermetic/sealed`. Each may also be set once for every rule in
 * `settings.hermetic`; the rule's own options win.
 *
 * - `types`: `"allow"` (default) permits type-only references that escape the
 *   function, since types are erased. `"structural-only"` reports escaping
 *   references to declared types, so the function can move to another file
 *   unchanged. Lib and other global types stay allowed.
 * - `ground`: path to a ground bootstrap module, absolute or relative to
 *   ESLint's working directory. Without it, the default ground applies.
 * - `aliasing`: `"best-effort"` (default) reports denied member paths where
 *   they are statically visible. `"forbid"` also reports any use of a ground
 *   object with denied members that could hand it elsewhere, such as
 *   `const m = Math` or `f(Math)`.
 */
export type SealedOptions = HermeticSettings;

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/bombadil-labs/hermetic/blob/main/docs/rules/${name}.md`,
);

// Annotated because the rule lints ground bootstraps with itself, so it refers to its own value.
export const sealed: TSESLint.RuleModule<MessageIds, [SealedOptions]> & { name: string } = createRule<
  [SealedOptions],
  MessageIds
>({
  name: "sealed",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require hermetic functions to read nothing but their inputs and the allowed globals",
    },
    schema: [{ type: "object", properties: SETTINGS_SCHEMA, additionalProperties: false }],
    defaultOptions: [{}],
    messages: {
      freeVariable:
        "'{{name}}' is a free variable in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      shadowedGround:
        "'{{name}}' in hermetic function '{{fn}}' refers to a variable declared outside it, not the allowed global. Pass it through 'this' or an argument.",
      groundWrite:
        "Hermetic function '{{fn}}' assigns to the allowed global '{{name}}'. Allowed globals can be read, not reassigned.",
      deniedPath:
        "'{{path}}' is not allowed in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      aliasedGround:
        "'{{path}}' has members that are not allowed, and hermetic function '{{fn}}' passes it on here, where they could be used. Pass what you need through 'this' or an argument.",
      typeReference:
        "Type reference '{{name}}' in hermetic function '{{fn}}' refers to a declaration outside it. With types: \"structural-only\", write the type inline.",
      lexicalThis:
        "'this' in hermetic arrow function '{{fn}}' comes from the enclosing scope, not from its inputs. Use a non-arrow function to receive 'this'.",
      lexicalNewTarget:
        "'new.target' in hermetic arrow function '{{fn}}' comes from the enclosing scope. Use a non-arrow function.",
      superReference:
        "'super' in hermetic function '{{fn}}' refers to the enclosing class or object. Pass the behavior through 'this' or an argument.",
      importMeta:
        "'import.meta' in hermetic function '{{fn}}' refers to the enclosing module. Pass the value through 'this' or an argument.",
      dynamicImport:
        "Dynamic import() in hermetic function '{{fn}}' loads a module that is not one of its inputs. Pass the module through 'this' or an argument.",
      jsx: "JSX in hermetic function '{{fn}}' compiles to a call to the JSX factory, which is a free variable. Pass an element factory through 'this' or an argument.",
    },
  },
  create(context, [options]) {
    const env = createEnvironment(context, options, sealed);
    const marked = new Map<TSESTree.Node, string>();
    /** Nested hermetic functions share escapes; each node is reported once, for the innermost. */
    const reported = new Set<TSESTree.Node>();

    return {
      ":function"(node: FunctionNode) {
        if (isMarkedHermetic(node, context.sourceCode)) marked.set(node, functionName(node));
      },
      // Inner functions exit first, so shared escapes are attributed to the innermost hermetic function.
      ":function:exit"(node: FunctionNode) {
        const name = marked.get(node);
        if (name === undefined) return;
        for (const { node: target, messageId, data } of analyze(node, name, env)) {
          if (reported.has(target)) continue;
          reported.add(target);
          context.report({ node: target, messageId, data });
        }
      },
    };
  },
});
