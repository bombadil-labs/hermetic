import * as tsParser from "@typescript-eslint/parser";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { applyDiscount, bindPricing, checkout, clampToCents, type PricingCtx } from "../examples/pricing.ts";
import plugin from "../src/index.ts";
import { repoRoot } from "./helpers.ts";

/** The spec's acid test for deterritorialization: rebuild a function from its source text alone. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const relocate = <F extends Function>(fn: F): F => new Function(`return (${fn.toString()});`)() as F;

describe("the pricing example", () => {
  const invoice = { id: "inv-1", total: 100 };

  it("binds authority in the binding layer", () => {
    const { price, checkout: total } = bindPricing({ discountRate: 0.1 });
    expect(price(invoice)).toEqual({ id: "inv-1", total: 90 });
    expect(total([invoice, { id: "inv-2", total: 50.555 }])).toBe(135.5);
  });

  it("passes the acid test: relocated functions behave identically", () => {
    const ctx: PricingCtx = { rate: 0.25, clamp: clampToCents };
    expect(relocate(applyDiscount).call(ctx, invoice)).toEqual(applyDiscount.call(ctx, invoice));
    expect(relocate(clampToCents)(1.005)).toBe(clampToCents(1.005));
    const price = (i: { id: string; total: number }) => ({ ...i, total: i.total / 2 });
    expect(relocate(checkout).call({ price }, [invoice, invoice])).toBe(checkout.call({ price }, [invoice, invoice]));
  });

  it("keeps the directive in the compiled source, where runtime tools can see it", () => {
    expect(applyDiscount.toString()).toContain('"use hermetic"');
  });
});

describe("the examples", () => {
  it("lint clean against the example ground bootstrap", async () => {
    const config: Linter.Config[] = [
      {
        files: ["**/*.ts"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { hermetic: plugin as never },
        rules: { "hermetic/sealed": ["error", { ground: "examples/hermetic.ground.ts", aliasing: "forbid" }] },
      },
    ];
    const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: true, overrideConfig: config });
    const results = await eslint.lintFiles(["examples/"]);
    expect(results.length).toBeGreaterThan(1);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  });
});
