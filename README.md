# @c9up/nova

> Web Push notifications for Ream — VAPID, subscription endpoint, and service-worker scaffolding.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/nova
ream configure @c9up/nova
```

## Usage

Register the provider in your app, then configure it under `config/nova.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/nova/provider'),
]
```

## Entry points

- `@c9up/nova` — main API
- `@c9up/nova/provider` — Ream IoC provider
- `@c9up/nova/services/main` — container service accessor
- `@c9up/nova/client` — browser/client entry
- `@c9up/nova/configure` — `configure` hook
- `@c9up/nova/testing` — test fakes & helpers

## License

MIT
