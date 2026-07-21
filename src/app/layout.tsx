import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ürün Sağlığı | ikas",
  description: "ikas ürün ve stok verilerini salt okunur olarak kontrol eden ürün sağlığı raporu.",
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
