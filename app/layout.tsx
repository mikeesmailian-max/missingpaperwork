import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mega Fleet Accounting Follow-Up",
  description:
    "Monitor incomplete carrier invoice packets and send documented follow-ups.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
