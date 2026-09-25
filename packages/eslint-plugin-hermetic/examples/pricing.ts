/**
 * The pricing example: business logic in hermetic functions, with everything
 * they use supplied by binding `this`, the built-ins they call included.
 */
import { type Intrinsics, intrinsics } from "@bombadil/hermetic";

export interface Invoice {
  readonly id: string;
  readonly total: number;
}

/** Exactly the dependencies pricing needs. */
export interface PricingCtx {
  readonly rate: number;
  readonly clamp: (n: number) => number;
}

export function applyDiscount(this: PricingCtx, invoice: Invoice): Invoice {
  "use hermetic";
  return { ...invoice, total: this.clamp(invoice.total * (1 - this.rate)) };
}

/** Rounds to whole cents. `Math` comes in through `this`, like anything else. */
export function clampToCents(this: Pick<Intrinsics, "Math">, n: number): number {
  "use hermetic";
  return this.Math.round(n * 100) / 100;
}

/** Totals invoices. Hermeticity is not transitive, so pricing arrives through `this`. */
export function checkout(this: { price: (invoice: Invoice) => Invoice }, invoices: readonly Invoice[]): number {
  "use hermetic";
  return invoices.map((invoice) => this.price(invoice).total).reduce((sum, total) => sum + total, 0);
}

// Supplying dependencies: ordinary code that builds `this` objects and binds
// them. Only the root environment reads the realm; everything else is built
// from it, and frozen, so no function can change what another one gets.

/** The built-ins these bindings draw from. */
const root = intrinsics(globalThis);

export function bindPricing(config: { readonly discountRate: number }, env: Pick<Intrinsics, "Math"> = root) {
  const clamp = clampToCents.bind(env);
  const price = applyDiscount.bind(Object.freeze({ rate: config.discountRate, clamp })); // (invoice: Invoice) => Invoice
  return { price, checkout: checkout.bind(Object.freeze({ price })) };
}
