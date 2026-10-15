# Streaming Platform

A monorepo for the **Streaming Platform** powered by [Turborepo](https://turbo.build/repo).

## Workspace Structure

- `apps/web`: Frontend web application
- `apps/api`: Backend API service
- `packages/typescript-config`: Shared `tsconfig.json` configurations
- `packages/shared-types`: Shared TypeScript types and interfaces

## Getting Started

Install dependencies from the root:

```bash
npm install
```

Run all apps in development mode:

```bash
npm run dev
```

Build all apps and packages:

```bash
npm run build
```
