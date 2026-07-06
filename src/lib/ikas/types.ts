export type IkasNamedEntity = {
  id: string;
  name: string;
};

export type IkasProductImage = {
  imageId?: string | null;
  fileName?: string | null;
  isMain?: boolean | null;
  isVideo?: boolean | null;
  order?: number | null;
};

export type IkasProductPrice = {
  sellPrice?: number | null;
  discountPrice?: number | null;
  buyPrice?: number | null;
  currencyCode?: string | null;
  currencySymbol?: string | null;
  priceListId?: string | null;
};

export type IkasProductStockLocation = {
  id: string;
  productId: string;
  variantId: string;
  stockLocationId: string;
  stockCount: number;
  deleted: boolean;
};

export type IkasProductVariant = {
  id: string;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  sku?: string | null;
  barcodeList?: string[] | null;
  images?: IkasProductImage[] | null;
  isActive: boolean;
  sellIfOutOfStock?: boolean | null;
  prices?: IkasProductPrice[] | null;
  stocks?: IkasProductStockLocation[] | null;
  deleted: boolean;
};

export type IkasProductSalesChannel = {
  id: string;
  status?: "HIDDEN" | "PASSIVE" | "VISIBLE" | null;
};

export type IkasProduct = {
  id: string;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  name: string;
  brand?: IkasNamedEntity | null;
  vendor?: IkasNamedEntity | null;
  categories?: IkasNamedEntity[] | null;
  tags?: IkasNamedEntity[] | null;
  description?: string | null;
  shortDescription?: string | null;
  metaData?: { id: string; slug: string } | null;
  totalStock?: number | null;
  salesChannels?: IkasProductSalesChannel[] | null;
  type: "BUNDLE" | "DIGITAL" | "MEMBERSHIP" | "PHYSICAL" | "SUBSCRIPTION";
  deleted: boolean;
  variants: IkasProductVariant[];
};

export type HealthIssueSeverity = "critical" | "warning" | "info";

export type HealthIssueCode =
  | "missing_sku"
  | "missing_barcode"
  | "duplicate_sku"
  | "duplicate_barcode"
  | "missing_image"
  | "missing_description"
  | "missing_category"
  | "missing_brand"
  | "missing_vendor"
  | "zero_stock_blocked"
  | "missing_price"
  | "duplicate_title"
  | "weird_description";

export type HealthIssue = {
  code: HealthIssueCode;
  severity: HealthIssueSeverity;
  productId: string;
  productName: string;
  variantId?: string;
  variantLabel?: string;
  message: string;
  value?: string | number;
  productUpdatedAt?: string;
};

export type MistakeRuleCode =
  | "incorrect_price"
  | "out_of_stock"
  | "missing_images"
  | "missing_sku"
  | "same_sku"
  | "duplicate_title"
  | "weird_description";

export type MistakeRuleSummary = {
  code: MistakeRuleCode;
  label: string;
  count: number;
};

export type ProductMistakeRow = {
  productId: string;
  productName: string;
  imageLabel: string;
  imageId?: string;
  imageFileName?: string | null;
  imageSrc?: string;
  updatedAt?: string;
  mistakes: string[];
  actionLabel: string;
};

export type HealthReport = {
  generatedAt: string;
  score: number;
  productCount: number;
  variantCount: number;
  issueCount: number;
  affectedProductCount: number;
  scanStatus: "success" | "queued";
  issueCountsByCode: Record<HealthIssueCode, number>;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  lowStockRiskCount: number;
  ruleSummaries: MistakeRuleSummary[];
  productRows: ProductMistakeRow[];
  issues: HealthIssue[];
};
