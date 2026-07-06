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
      <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500 ring-1 ring-slate-200">
        {src ? "IMG" : label.slice(0, 3)}
      </div>
    );
  }

  return (
    <img
      alt={alt}
      className="h-14 w-14 rounded-lg object-cover ring-1 ring-slate-200"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}
