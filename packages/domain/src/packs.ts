/**
 * Pack hierarchy and base-unit conversion (AD-2, AD-3).
 *
 * The client receives cases and sells singles, and the two are unrelated
 * records in their current master - `Charhons 500g` and
 * `Charhons biscuits 10x500g` with no rule connecting them. That alone
 * plausibly explains a large share of the USD 214,516 variance.
 *
 * Here a product has ONE base unit and many packs. `qtyBase` is how many base
 * units a pack contains. Conversion happens here, at the edge; the ledger
 * only ever sees base units.
 */

import {
  assertBarcodeRegistrable,
  type BarcodeRegistrationOptions,
  type Symbology,
} from './barcode.js';
import { InvalidMasterData, ProductMerged, UnlistedBarcode } from './errors.js';
import type { BarcodeBinding, Product, ProductPack, Uuid } from './types.js';

/**
 * Convert a pack quantity to base units.
 *
 * 50 cases of 10 becomes 500 singles. This is the only place the multiplier is
 * applied; nothing downstream knows packs exist.
 */
export function packsToBase(qtyPacks: number, qtyBasePerPack: number): number {
  if (!Number.isFinite(qtyPacks)) {
    throw new InvalidMasterData('Pack quantity must be a finite number', { qtyPacks });
  }
  if (!Number.isFinite(qtyBasePerPack) || qtyBasePerPack <= 0) {
    // CHECK (qty_base > 0) on product_pack.
    throw new InvalidMasterData('Pack size must be greater than zero', { qtyBasePerPack });
  }
  return qtyPacks * qtyBasePerPack;
}

/**
 * Present a base-unit quantity as whole packs plus a base-unit remainder.
 *
 * Display only. The remainder is never rounded away, because rounding stock
 * is how a ledger stops reconciling.
 */
export function baseToPacks(
  qtyBase: number,
  qtyBasePerPack: number,
): { packs: number; remainderBase: number } {
  if (!Number.isFinite(qtyBasePerPack) || qtyBasePerPack <= 0) {
    throw new InvalidMasterData('Pack size must be greater than zero', { qtyBasePerPack });
  }
  const sign = qtyBase < 0 ? -1 : 1;
  const magnitude = Math.abs(qtyBase);
  const whole = Math.floor(magnitude / qtyBasePerPack);
  const remainder = magnitude - whole * qtyBasePerPack;
  return { packs: sign * whole, remainderBase: sign * remainder };
}

export interface ProductInput {
  id: Uuid;
  sku: string;
  name: string;
  baseUom: string;
  isWeighed?: boolean;
  mergedIntoId?: Uuid | null;
}

export interface ProductPackInput {
  id: Uuid;
  productId: Uuid;
  label: string;
  qtyBase: number;
}

export interface BarcodeInput {
  code: string;
  packId: Uuid;
  symbology?: Symbology;
}

/**
 * In-memory product master enforcing the uniqueness and shape rules that
 * `001_core.sql` enforces in the database.
 *
 * It lives in `packages/domain` because the offline POS needs to resolve a
 * scan and reject a bad barcode with no network. The server holds the same
 * rules in Postgres; this is the same contract, not a second copy of it.
 */
export class MasterData {
  readonly #products = new Map<Uuid, Product>();
  readonly #skus = new Map<string, Uuid>();
  readonly #packs = new Map<Uuid, ProductPack>();
  readonly #packLabels = new Set<string>();
  readonly #barcodes = new Map<string, BarcodeBinding>();
  readonly #registration: BarcodeRegistrationOptions;

  constructor(registration: BarcodeRegistrationOptions = {}) {
    this.#registration = registration;
  }

  addProduct(input: ProductInput): Product {
    if (this.#products.has(input.id)) {
      throw new InvalidMasterData(`Duplicate product id: ${input.id}`, { id: input.id });
    }
    // product.sku UNIQUE
    const existingSku = this.#skus.get(input.sku);
    if (existingSku !== undefined) {
      throw new InvalidMasterData(`Duplicate SKU: ${input.sku}`, {
        sku: input.sku,
        existingProductId: existingSku,
      });
    }
    const mergedIntoId = input.mergedIntoId ?? null;
    // CONSTRAINT product_not_self_merged
    if (mergedIntoId !== null && mergedIntoId === input.id) {
      throw new InvalidMasterData('A product cannot be merged into itself', { id: input.id });
    }

    const product: Product = {
      id: input.id,
      sku: input.sku,
      name: input.name,
      baseUom: input.baseUom,
      isWeighed: input.isWeighed ?? false,
      mergedIntoId,
    };
    this.#products.set(product.id, product);
    this.#skus.set(product.sku, product.id);
    return product;
  }

  addPack(input: ProductPackInput): ProductPack {
    if (this.#packs.has(input.id)) {
      throw new InvalidMasterData(`Duplicate pack id: ${input.id}`, { id: input.id });
    }
    if (!this.#products.has(input.productId)) {
      throw new InvalidMasterData(`Pack references unknown product: ${input.productId}`, {
        productId: input.productId,
      });
    }
    // CHECK (qty_base > 0)
    if (!Number.isFinite(input.qtyBase) || input.qtyBase <= 0) {
      throw new InvalidMasterData('Pack qtyBase must be greater than zero', {
        qtyBase: input.qtyBase,
      });
    }
    // UNIQUE (product_id, label)
    const labelKey = `${input.productId} ${input.label}`;
    if (this.#packLabels.has(labelKey)) {
      throw new InvalidMasterData(
        `Duplicate pack label for product: ${input.label}`,
        { productId: input.productId, label: input.label },
      );
    }

    const pack: ProductPack = {
      id: input.id,
      productId: input.productId,
      label: input.label,
      qtyBase: input.qtyBase,
    };
    this.#packs.set(pack.id, pack);
    this.#packLabels.add(labelKey);
    return pack;
  }

  /**
   * Bind a barcode to a pack.
   *
   * `barcode.code` is the primary key in the schema, so one code resolves to
   * exactly one pack, hence one product and one multiplier. This is the
   * constraint whose absence let Three Leaves 125g acquire four records under
   * four barcodes.
   */
  addBarcode(input: BarcodeInput): BarcodeBinding {
    const symbology = input.symbology ?? 'ean13';
    assertBarcodeRegistrable(input.code, symbology, this.#registration);

    // barcode.code PRIMARY KEY
    const existing = this.#barcodes.get(input.code);
    if (existing !== undefined) {
      throw new InvalidMasterData(`Barcode already bound: ${input.code}`, {
        code: input.code,
        existingPackId: existing.packId,
        existingProductId: existing.productId,
      });
    }

    const pack = this.#packs.get(input.packId);
    if (pack === undefined) {
      throw new InvalidMasterData(`Barcode references unknown pack: ${input.packId}`, {
        packId: input.packId,
      });
    }

    const binding: BarcodeBinding = {
      code: input.code,
      packId: pack.id,
      productId: pack.productId,
      qtyBase: pack.qtyBase,
    };
    this.#barcodes.set(binding.code, binding);
    return binding;
  }

  /**
   * Resolve a scan to a product and its pack multiplier.
   *
   * Throws `UnlistedBarcode` rather than returning null: the old platform let
   * an unresolved scan pass silently, which is how under-the-counter sales
   * stayed invisible (HANDOFF section 2.7).
   */
  resolveBarcode(code: string): BarcodeBinding {
    const binding = this.#barcodes.get(code);
    if (binding === undefined) throw new UnlistedBarcode(code);
    return binding;
  }

  getProduct(productId: Uuid): Product | undefined {
    return this.#products.get(productId);
  }

  getPack(packId: Uuid): ProductPack | undefined {
    return this.#packs.get(packId);
  }

  /**
   * Guard before any movement. A product merged during master-data cleanse
   * keeps its history but accepts no new movements - no hard deletes, ever
   * (HANDOFF section 10).
   */
  assertTransactable(productId: Uuid): Product {
    const product = this.#products.get(productId);
    if (product === undefined) {
      throw new InvalidMasterData(`Unknown product: ${productId}`, { productId });
    }
    if (product.mergedIntoId !== null) {
      throw new ProductMerged(product.id, product.mergedIntoId);
    }
    return product;
  }
}
