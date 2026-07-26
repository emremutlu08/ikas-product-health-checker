import { describe, expect, it } from "vitest";

import { config } from "./config";

describe("ikas OAuth scope configuration", () => {
  it("requests the Partner-approved product and inventory read/write scopes", () => {
    expect(new Set(config.oauth.scope.split(","))).toEqual(
      new Set([
        "read_products",
        "read_inventories",
        "write_products",
        "write_inventories",
      ]),
    );
  });
});
