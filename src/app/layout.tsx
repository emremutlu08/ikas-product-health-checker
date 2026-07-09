import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ikas Ürün Sağlığı Asistanı",
  description: "ikas ürün verilerini yalnızca okuma modunda kontrol eden sağlık raporu MVP’si.",
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
