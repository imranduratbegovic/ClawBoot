import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("http://localhost:3210"),
  title: "ClawBoot",
  description:
    "A simple Raspberry Pi setup wizard for OpenClaw and a local Qwen 3.5 2B model.",
  applicationName: "ClawBoot",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
