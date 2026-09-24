import type { TSESTree } from "@typescript-eslint/utils";

export type VisitorKeys = Readonly<Record<string, readonly string[] | undefined>>;

/** The nodes directly under `node`, in the order `visitorKeys` lists them. */
export function* childNodes(node: TSESTree.Node, visitorKeys: VisitorKeys): Generator<TSESTree.Node> {
  for (const key of visitorKeys[node.type] ?? []) {
    const child: unknown = (node as unknown as Record<string, unknown>)[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string") {
        yield item as TSESTree.Node;
      }
    }
  }
}
