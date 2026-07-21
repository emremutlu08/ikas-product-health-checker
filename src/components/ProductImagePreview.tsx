"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

type ProductImagePreviewProps = {
  src?: string;
  alt: string;
  label: string;
};

export function ProductImagePreview({ src, alt, label }: ProductImagePreviewProps) {
  const [failed, setFailed] = useState(!src);

  if (failed || !src) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-md border border-border bg-surface-sunken text-label font-semibold text-text-muted">
        {src ? "IMG" : label.slice(0, 3)}
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className="h-14 w-14 rounded-md border border-border object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}
