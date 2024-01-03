// Import the base CSS styles for the radix-ui components.
import "@radix-ui/themes/styles.css";
import "./globals.css"
import { Inter as FontSans } from "next/font/google"
import { cn } from "../lib/utils";
import type { Metadata } from "next";
import { Theme, Card, Container, Flex } from "@radix-ui/themes";
import Link from "next/link";
import { Footer } from "../components/footer";
import { Button } from "@/components/ui/button"
import { SignInButton } from "../components/ui/sign-in-button";

export const metadata: Metadata = {
  title: "Slack-to-Zendesk",
  description: "Keep your customer Slack channels organized by syncing threads with Zendesk tickets.",
};

export const fontSans = FontSans({
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
        <Theme accentColor="iris" style={{ backgroundColor: "var(--gray-1)" }}>
          <Container px="5">
            <Flex align="center" style={{ height: "100vh" }} py="9">
              <Flex
                direction="column"
                style={{
                  height: "100%",
                  maxHeight: 850,
                  minHeight: 500,
                  width: "100%",
                }}
                gap="5"
              >
                <Flex grow="1">
                  <Card size="4" style={{ width: "100%" }}>
                    <Flex direction="column" height="100%">
                      <Flex asChild justify="between">
                        <header>
                          <Flex gap="4">
                            <Button variant="secondary">
                              <Link href="/">Home</Link>
                            </Button>

                            <Button variant="secondary">
                              <Link href="/account">Account</Link>
                            </Button>
                          </Flex>

                          <SignInButton />
                        </header>
                      </Flex>

                      <Flex grow="1" align="center" justify="center">
                        <main>{children}</main>
                      </Flex>
                    </Flex>
                  </Card>
                </Flex>
                <Footer />
              </Flex>
            </Flex>
          </Container>
        </Theme>
      </body>
    </html>
  );
}