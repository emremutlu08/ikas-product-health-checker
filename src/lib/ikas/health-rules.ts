import type {
  HealthIssue,
  HealthIssueCode,
  HealthIssueSeverity,
  IkasProduct,
  IkasProductVariant,
  HealthReport,
  MistakeRuleCode,
  ProductMistakeRow,
} from "./types";

const ISSUE_CODES: HealthIssueCode[] = [
  "missing_sku",
  "missing_barcode",
  "duplicate_sku",
  "duplicate_barcode",
  "missing_image",
  "missing_description",
  "missing_category",
  "missing_brand",
  "missing_vendor",
  "zero_stock_blocked",
  "missing_price",
  "duplicate_title",
  "weird_description",
];


const RULE_LABELS: Record<MistakeRuleCode, string> = {
  incorrect_price: "Incorrect Price",
  out_of_stock: "Out Of Stock",
  missing_images: "Missing Images",
  missing_sku: "Missing SKU",
  same_sku: "Same SKU",
  duplicate_title: "Duplicate Title",
  weird_description: "Weird Description",
};

const ISSUE_TO_RULE: Partial<Record<HealthIssueCode, MistakeRuleCode>> = {
  missing_price: "incorrect_price",
  zero_stock_blocked: "out_of_stock",
  missing_image: "missing_images",
  missing_sku: "missing_sku",
  duplicate_sku: "same_sku",
  duplicate_title: "duplicate_title",
  weird_description: "weird_description",
};

const WEIGHTS: Record<HealthIssueSeverity, number> = {
  critical: 7,
  warning: 4,
  info: 1,
};

function clean(value: string | null | undefined) {
  return (value ?? "").trim();
}

function normalized(value: string | null | undefined) {
  return clean(value).toLocaleUpperCase("tr-TR");
}

function activeProducts(products: IkasProduct[]) {
  return products.filter((product) => !product.deleted);
}

function activeVariants(product: IkasProduct) {
  return product.variants.filter((variant) => variant.isActive && !variant.deleted);
}

function variantLabel(variant: IkasProductVariant) {
  return clean(variant.sku) || variant.id;
}

function variantStock(variant: IkasProductVariant) {
  return (variant.stocks ?? [])
    .filter((stock) => !stock.deleted)
    .reduce((total, stock) => total + stock.stockCount, 0);
}

function hasSellPrice(variant: IkasProductVariant) {
  return (variant.prices ?? []).some((price) => typeof price.sellPrice === "number" && price.sellPrice > 0);
}

function isoDate(value: string | number | null | undefined) {
  if (!value) return undefined;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function productImageLabel(product: IkasProduct) {
  const image = activeVariants(product).flatMap((variant) => variant.images ?? []).find((item) => item.imageId || item.fileName);
  return image?.fileName || image?.imageId || product.name.slice(0, 2).toLocaleUpperCase("tr-TR");
}

function addIssue(
  issues: HealthIssue[],
  product: IkasProduct,
  code: HealthIssueCode,
  severity: HealthIssueSeverity,
  message: string,
  variant?: IkasProductVariant,
  value?: string | number,
) {
  issues.push({
    code,
    severity,
    productId: product.id,
    productName: product.name,
    variantId: variant?.id,
    variantLabel: variant ? variantLabel(variant) : undefined,
    message,
    value,
    productUpdatedAt: isoDate(variant?.updatedAt ?? product.updatedAt ?? product.createdAt),
  });
}

export function buildHealthReport(products: IkasProduct[], now = new Date()): HealthReport {
  const visibleProducts = activeProducts(products);
  const issues: HealthIssue[] = [];
  const skuIndex = new Map<string, Array<{ product: IkasProduct; variant: IkasProductVariant }>>();
  const barcodeIndex = new Map<string, Array<{ product: IkasProduct; variant: IkasProductVariant }>>();
  const titleIndex = new Map<string, IkasProduct[]>();

  let variantCount = 0;

  for (const product of visibleProducts) {
    const variants = activeVariants(product);
    variantCount += variants.length;

    const title = normalized(product.name);
    if (title) titleIndex.set(title, [...(titleIndex.get(title) ?? []), product]);

    const descriptionText = clean(product.description) || clean(product.shortDescription);
    if (!descriptionText) {
      addIssue(issues, product, "missing_description", "warning", "Üründe açıklama veya kısa açıklama yok.");
    } else if (descriptionText.length < 20 || /^[-_.!?,\s]+$/.test(descriptionText)) {
      addIssue(issues, product, "weird_description", "warning", "Ürün açıklaması çok kısa veya anlamsız görünüyor.");
    }

    if (!product.categories?.length) {
      addIssue(issues, product, "missing_category", "warning", "Ürün hiçbir kategoriye bağlı değil.");
    }

    if (!product.brand) {
      addIssue(issues, product, "missing_brand", "info", "Üründe brand bilgisi yok.");
    }

    if (!product.vendor) {
      addIssue(issues, product, "missing_vendor", "info", "Üründe vendor/tedarikçi bilgisi yok.");
    }

    for (const variant of variants) {
      const sku = normalized(variant.sku);
      if (!sku) {
        addIssue(issues, product, "missing_sku", "critical", "Aktif varyantta SKU eksik.", variant);
      } else {
        skuIndex.set(sku, [...(skuIndex.get(sku) ?? []), { product, variant }]);
      }

      const barcodes = (variant.barcodeList ?? []).map(normalized).filter(Boolean);
      if (barcodes.length === 0) {
        addIssue(issues, product, "missing_barcode", "warning", "Aktif varyantta barkod yok.", variant);
      }
      for (const barcode of barcodes) {
        barcodeIndex.set(barcode, [...(barcodeIndex.get(barcode) ?? []), { product, variant }]);
      }

      if (!(variant.images ?? []).some((image) => image.imageId || image.fileName)) {
        addIssue(issues, product, "missing_image", "warning", "Aktif varyantta görsel yok.", variant);
      }

      if (!hasSellPrice(variant)) {
        addIssue(issues, product, "missing_price", "critical", "Aktif varyantta geçerli satış fiyatı yok.", variant);
      }

      const stock = variantStock(variant);
      if (stock <= 0 && variant.sellIfOutOfStock !== true) {
        addIssue(
          issues,
          product,
          "zero_stock_blocked",
          "critical",
          "Varyant stokta yok ve stok dışı satış kapalı.",
          variant,
          stock,
        );
      }
    }
  }

  for (const [title, productsWithTitle] of titleIndex.entries()) {
    if (productsWithTitle.length <= 1) continue;
    for (const product of productsWithTitle) {
      addIssue(issues, product, "duplicate_title", "warning", `Ürün başlığı başka ürünlerde de kullanılıyor: ${title}`, undefined, title);
    }
  }

  for (const [sku, entries] of skuIndex.entries()) {
    if (entries.length <= 1) continue;
    for (const { product, variant } of entries) {
      addIssue(issues, product, "duplicate_sku", "critical", `SKU başka aktif varyantlarda da kullanılıyor: ${sku}`, variant, sku);
    }
  }

  for (const [barcode, entries] of barcodeIndex.entries()) {
    if (entries.length <= 1) continue;
    for (const { product, variant } of entries) {
      addIssue(
        issues,
        product,
        "duplicate_barcode",
        "warning",
        `Barkod başka aktif varyantlarda da kullanılıyor: ${barcode}`,
        variant,
        barcode,
      );
    }
  }

  const issueCountsByCode = Object.fromEntries(ISSUE_CODES.map((code) => [code, 0])) as Record<HealthIssueCode, number>;
  for (const issue of issues) issueCountsByCode[issue.code] += 1;

  const criticalCount = issues.filter((issue) => issue.severity === "critical").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;
  const weightedPenalty = issues.reduce((total, issue) => total + WEIGHTS[issue.severity], 0);
  const score = Math.max(0, Math.round(100 - weightedPenalty * 0.9));
  const affectedProductIds = new Set(issues.map((issue) => issue.productId));

  const ruleCounts = new Map<MistakeRuleCode, Set<string>>();
  for (const code of Object.keys(RULE_LABELS) as MistakeRuleCode[]) ruleCounts.set(code, new Set());
  for (const issue of issues) {
    const rule = ISSUE_TO_RULE[issue.code];
    if (rule) ruleCounts.get(rule)?.add(issue.productId);
  }

  const ruleSummaries = (Object.keys(RULE_LABELS) as MistakeRuleCode[]).map((code) => ({
    code,
    label: RULE_LABELS[code],
    count: ruleCounts.get(code)?.size ?? 0,
  }));

  const grouped = new Map<string, ProductMistakeRow>();
  for (const issue of issues) {
    const rule = ISSUE_TO_RULE[issue.code];
    if (!rule) continue;
    const product = visibleProducts.find((item) => item.id === issue.productId);
    const current = grouped.get(issue.productId) ?? {
      productId: issue.productId,
      productName: issue.productName,
      imageLabel: product ? productImageLabel(product) : issue.productName.slice(0, 2).toLocaleUpperCase("tr-TR"),
      updatedAt: issue.productUpdatedAt,
      mistakes: [],
      actionLabel: "Review",
    };
    if (!current.mistakes.includes(RULE_LABELS[rule])) current.mistakes.push(RULE_LABELS[rule]);
    grouped.set(issue.productId, current);
  }

  return {
    generatedAt: now.toISOString(),
    score,
    productCount: visibleProducts.length,
    variantCount,
    issueCount: issues.length,
    affectedProductCount: affectedProductIds.size,
    scanStatus: "success",
    issueCountsByCode,
    criticalCount,
    warningCount,
    infoCount,
    lowStockRiskCount: issueCountsByCode.zero_stock_blocked,
    ruleSummaries,
    productRows: Array.from(grouped.values()).sort((a, b) => b.mistakes.length - a.mistakes.length),
    issues,
  };
}
