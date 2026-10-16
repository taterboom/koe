import type { Localized } from './i18n';
import type { Kind } from './feedback';

export interface ProductConfig {
  name: string;
  display_name?: Localized<string>;
  logo_url?: string;
  // The feedback types this product's page offers, in display order.
  kinds: Kind[];
}

export type ProductMap = Record<string, ProductConfig>;

// /admin is routed first, so a product cannot be called "admin".
export function isKnownProduct(products: ProductMap, key: unknown): key is string {
  return typeof key === 'string' && key !== 'admin' && Object.hasOwn(products, key);
}
