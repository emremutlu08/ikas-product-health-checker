import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./error";
import Loading from "./loading";
import NotFound from "./not-found";

describe("app runtime boundaries", () => {
  it("renders an accessible Turkish loading state", () => {
    const html = renderToStaticMarkup(<Loading />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Sayfa hazırlanıyor");
    expect(html).toContain("İstenen ekran güvenli biçimde yükleniyor");
    expect(html).not.toContain("Rapor hazırlanıyor");
    expect(html).not.toContain("Loading");
  });

  it("renders a Turkish not-found state inside the product surface", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain("Sayfa bulunamadı");
    expect(html).toContain('href="/"');
    expect(html).not.toContain("This page could not be found");
  });

  it("renders safe recovery and a sanitized support digest without leaking the error", () => {
    const error = Object.assign(new Error("sensitive upstream detail"), { digest: "146882781" });
    const html = renderToStaticMarkup(
      <ErrorBoundary error={error} reset={vi.fn()} unstable_retry={vi.fn()} />,
    );

    expect(html).toContain("Rapor şu anda açılamıyor");
    expect(html).toContain("Yeniden dene");
    expect(html).toContain("Destek kodu: 146882781");
    expect(html).not.toContain("sensitive upstream detail");
  });

  it("does not reflect an unsafe digest", () => {
    const error = Object.assign(new Error("sensitive upstream detail"), {
      digest: "<script>alert(1)</script>",
    });
    const html = renderToStaticMarkup(
      <ErrorBoundary error={error} reset={vi.fn()} unstable_retry={vi.fn()} />,
    );

    expect(html).not.toContain("Destek kodu:");
    expect(html).not.toContain("alert(1)");
  });
});
