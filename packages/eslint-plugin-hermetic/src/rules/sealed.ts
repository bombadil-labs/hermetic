import { ESLintUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { analyze, createEnvironment, type HermeticSettings, type MessageIds, SETTINGS_SCHEMA } from "../analysis.ts";
import { type FunctionNode, functionName, isMarkedHermetic, isMethod } from "../marking.ts";

export type { MessageIds } from "../analysis.ts";

/**
 * Options for `hermetic/sealed`. Each may also be set once for every rule in
 * `settings.hermetic`; the rule's own options win.
 *
 * - `types`: `"allow"` (default) permits type-only references that escape the
 *   function, since types are erased. `"structural-only"` reports escaping
 *   references to declared types, so the function can move to another file
 *   unchanged. Lib and other global types stay allowed.
 */
export type SealedOptions = HermeticSettings;

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/bombadil-labs/hermetic/blob/main/docs/rules/${name}.md`,
);

export const sealed: TSESLint.RuleModule<MessageIds, [SealedOptions]> & { name: string } = createRule<
  [SealedOptions],
  MessageIds
>({
  name: "sealed",
  meta: {
    type: "problem",
    docs: {
      description: "Require hermetic functions to read nothing but their inputs",
    },
    schema: [{ type: "object", properties: SETTINGS_SCHEMA, additionalProperties: false }],
    defaultOptions: [{}],
    messages: {
      freeVariable:
        "'{{name}}' is a free variable in hermetic function '{{fn}}'. Pass it through 'this' or an argument.",
      method:
        "'{{fn}}' is a method, and methods can't be hermetic yet: a method's 'this' is its object, not its inputs. Make it a function, and pass the object in.",
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
    const env = createEnvironment(context, options);
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
        if (isMethod(node)) {
          context.report({ node: node.parent, messageId: "method", data: { fn: name } });
          return;
        }
        for (const { node: target, messageId, data } of analyze(node, name, env)) {
          if (reported.has(target)) continue;
          reported.add(target);
          context.report({ node: target, messageId, data });
        }
      },
    };
  },
});
