// Import the base CSS styles for the radix-ui components.
import "./globals.css"
import { Inter as FontSans } from "next/font/google"
import { cn } from "../lib/utils";
import type { Metadata } from "next";
import Link from "next/link";
import { Footer } from "../components/footer";
import { SignInButton } from "../components/ui/sign-in-button";
import { MainNav } from "@/components/main-nav";

export const metadata: Metadata = {
  title: "Slack-to-Zendesk",
  description: "Keep your customer Slack channels organized by syncing threads with Zendesk tickets.",
};

const fontSans = FontSans({
  subsets: ["latin"],
  variable: "--font-sans",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
      style={{ padding: 0, margin: 0 }}
      className={cn(
        "min-h-screen bg-background font-sans antialiased",
        fontSans.variable
      )}
      >
      <div className="border-b">
          <div className="flex h-16 items-center px-4">
          <Link href="/" className="text-2xl font-bold tracking-tight">Slack-to-Zendesk</Link>
            <MainNav className="mx-6" />
            <div className="ml-auto flex items-center space-x-4">
              <SignInButton />
            </div>
          </div>
      </div>
      <div className="flex-1 lg:max-w-2xl">{children}</div>
      </body>
    </html>
  );
}