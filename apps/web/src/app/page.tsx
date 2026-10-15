import React from "react";

export default function HomePage() {
  return (
    <main style={{ maxWidth: "960px", margin: "0 auto", padding: "3rem 1.5rem" }}>
      <header style={{ marginBottom: "2.5rem" }}>
        <h1 style={{ fontSize: "2.25rem", marginBottom: "0.5rem" }}>
          Streaming Platform
        </h1>
        <p style={{ color: "#a1a1aa", margin: 0 }}>
          Next.js Viewer Client &bull; Connected to Turborepo Workspace
        </p>
      </header>

      <section
        style={{
          backgroundColor: "#18181b",
          border: "1px solid #27272a",
          borderRadius: "12px",
          padding: "2rem",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Workspace Ready</h2>
        <p style={{ color: "#d4d4d8", lineHeight: 1.6 }}>
          The <code>apps/web</code> (Next.js on port 3000) and{" "}
          <code>apps/api</code> (Express.js on port 4000) packages are
          configured. Start both servers concurrently from the root directory
          with <code>npm run dev</code>.
        </p>
      </section>
    </main>
  );
}
