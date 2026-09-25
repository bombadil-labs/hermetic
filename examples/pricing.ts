/**
 * The pricing example: business logic in hermetic functions, with their
 * dependencies supplied by binding `this`.
 */

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

/** Rounds to whole cents. */
export function clampToCents(n: number): number {
  "use hermetic";
  return Math.round(n * 100) / 100;
}

/** Totals invoices. Hermeticity is not transitive, so pricing arrives through `this`. */
export function checkout(this: { price: (invoice: Invoice) => Invoice }, invoices: readonly Invoice[]): number {
  "use hermetic";
  return invoices.map((invoice) => this.price(invoice).total).reduce((sum, total) => sum + total, 0);
}

// Supplying dependencies: ordinary code that builds `this` objects and binds
// them. Hermetic functions compose by passing bound ones into other `this`
// objects.

export function bindPricing(config: { readonly discountRate: number }) {
  const pricing: PricingCtx = { rate: config.discountRate, clamp: clampToCents };
  const price = applyDiscount.bind(pricing); // (invoice: Invoice) => Invoice
  return { price, checkout: checkout.bind({ price }) };
}
