import type { Metadata } from "next";
import "./globals.css";
import { APP_FULL_NAME } from "@/globals/branding";

export const metadata: Metadata = {
  title: APP_FULL_NAME,
  description:
    "ikas ürün ve stok verilerini tarayıp sorunları raporlar; düzeltmeler yalnızca siz onaylarsanız yazılır.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      className="h-full antialiased"
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
