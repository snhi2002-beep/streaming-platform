import React from "react";

export const metadata = {
  title: "Streaming Platform",
  description: "Next.js web client for the Streaming Platform monorepo",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, sans-serif",
          backgroundColor: "#0f0f12",
          color: "#f4f4f6",
        }}
      >
        {children}
      </body>
    </html>
  );
}
