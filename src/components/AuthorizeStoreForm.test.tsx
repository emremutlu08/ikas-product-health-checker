import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthorizeStoreForm } from "./AuthorizeStoreForm";

describe("AuthorizeStoreForm", () => {
  it("states what the app may do to the catalog before the merchant authorizes it", () => {
    const html = renderToStaticMarkup(
      <AuthorizeStoreForm initialStoreName="dev-emre2" supportId="" />,
    );

    // This box is the last thing a merchant reads before granting access, so it is the one place
    // an over-promise is most expensive. It promised the app never writes; it now promises the
    // thing that is actually guaranteed — no write without their confirmation.
    expect(html).toContain("Onaysız hiçbir şey değişmez");
    expect(html).toContain("tarama hiçbir şeyi değiştirmez");
    expect(html).toContain("yalnızca sen önizleyip onayladığında yazılır");
    expect(html).not.toContain("Ürün veya stok bilgileri değiştirilmez");
    expect(html).toContain("Bağlantıdan sonra ilk sağlık raporun açılır");
    expect(html).toContain("ikas ile güvenli şekilde bağlan");
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('aria-describedby="storeName-help"');
  });

  it("keeps server-side failures separate and exposes accessible copy feedback", () => {
    const html = renderToStaticMarkup(
      <AuthorizeStoreForm
        failureReason="oauth_authorize_failed"
        initialStoreName="dev-emre2"
        supportId="123e4567-e89b-42d3-a456-426614174000"
      />,
    );

    expect(html).not.toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-describedby="storeName-help"');
    expect(html).toContain(">Kopyala</button>");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("select-all");
    expect(html).not.toContain("sensitive");
  });

  it("marks only an invalid store name as an input error", () => {
    const html = renderToStaticMarkup(
      <AuthorizeStoreForm failureReason="invalid_store_name" initialStoreName="bad store" supportId="" />,
    );

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="storeName-help authorization-error"');
  });
});
