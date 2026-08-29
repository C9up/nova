# @c9up/nova

> Web Push for Ream — VAPID keys, a subscription endpoint, durable storage, and the client half.

Part of **[Ream](https://github.com/C9up/ream)**. Independent and publishable: the framework is an
optional peer, so the push side works in any Node application.

## Install

```bash
pnpm add @c9up/nova
ream configure @c9up/nova
```

`configure` registers the provider, writes `config/nova.ts`, stubs the three `NOVA_VAPID_*`
variables in `.env`, drops a service worker at `public/sw.js`, adds a migration for the durable
subscription table, and registers the `nova:vapid:generate` command.

## Mint the keys

Web Push signs every message with a VAPID key pair. It is per application and stable: losing the
private key invalidates every live subscription, so the command refuses to overwrite one unless you
say so.

```bash
ream nova:vapid:generate            # writes NOVA_VAPID_* into .env
ream nova:vapid:generate --force    # replaces them — every current subscription stops working
```

Outside a Ream application, mint them in code:

```ts
import { generateVapidKeys } from '@c9up/nova'

const { publicKey, privateKey } = generateVapidKeys()
```

## Configure

```ts
// config/nova.ts
import { defineConfig } from '@c9up/nova'
import env from '#start/env'

export default defineConfig({
  routePrefix: '/api/nova',   // POST /api/nova/subscribe is registered here
  guard: 'jwt',               // warden guard on that route; null disables it (tests only)
  vapid: {
    publicKey: env.get('NOVA_VAPID_PUBLIC_KEY'),
    privateKey: env.get('NOVA_VAPID_PRIVATE_KEY'),
    subject: env.get('NOVA_VAPID_SUBJECT'),   // mailto: or https:, identifies you to the push service
  },
})
```

The provider registers `POST {routePrefix}/subscribe`, guarded unless `guard` is `null`. Its handler
stores the browser's subscription against the authenticated user.

`vapid` is only needed to SEND: the subscription endpoint works without it.

## Send a notification

```ts
import push from '@c9up/nova/services/main'

// One device.
const result = await push.push(subscription, {
  title: 'Order shipped',
  body: 'Tracking number 4711',
  data: { orderId: 42 },
})

// Every device a user has subscribed.
const results = await push.pushToUser(userId, { title: 'Order shipped' })
```

`push()` resolves to `{ ok, status, endpoint }`, and to `{ ok: false, reason }` when the push service
refuses. A subscription the browser has dropped comes back as `reason: 'gone'` — and nova deletes it
from the store on the spot, reporting whether that succeeded in `cleaned`. `pushToUser()` fans out
and returns one result per device: a device that fails does not stop the others.

Options travel per call:

```ts
await push.push(subscription, payload, {
  ttl: 3600,           // seconds the push service may hold the message
  urgency: 'high',     // very-low | low | normal | high
  topic: 'order-42',   // a later message with the same topic replaces this one
})
```

## The browser half

```ts
import { registerServiceWorker, subscribe } from '@c9up/nova/client'

await registerServiceWorker('/sw.js')
await subscribe({
  publicKey: '<NOVA_VAPID_PUBLIC_KEY>',
  endpoint: '/api/nova/subscribe',   // where the subscription is POSTed
  headers: { Authorization: `Bearer ${token}` },
})
```

`subscribe()` asks for permission, subscribes through the service worker, and posts the result to
your application. The `public/sw.js` written by `configure` displays the notification and focuses
the window on click — edit it, it is yours.

## Storage

Subscriptions live behind a `SubscriptionStore`. Nova ships one
implementation, `MemorySubscriptionDriver`, and the provider uses it by default. That is right for
tests and wrong for production: it forgets every subscription on restart.

`configure` writes a migration creating the durable table, so the schema is there for a driver of
your own:

```ts
// config/nova.ts
export default defineConfig({
  store: new MyAtlasSubscriptionStore(db),   // anything implementing SubscriptionStore
})
```

```ts
export interface SubscriptionStore {
  save(userId: string, subscription: PushSubscription): Promise<void>
  listByUser(userId: string): Promise<PushSubscription[]>
  delete(endpoint: string): Promise<void>
}
```

## Testing

```ts
import { FakeNova } from '@c9up/nova/testing'
import { nova, useContainer } from '@c9up/helix'

useContainer(container)
nova.fake(FakeNova)

await orderShipped(order)

nova.assertPushed({ userId: 'user-A', title: 'Order shipped' })
nova.assertNotPushed({ title: 'Order cancelled' })
```

Nothing leaves the process: `FakeNova` captures instead of sending, and answers a synthetic
`{ ok: true, status: 201 }`. It captures only — for the real fan-out semantics (one result per
device, `gone` cleanup) build a real `Nova` over a `MemorySubscriptionDriver` seeded with fixtures.

## Entry points

| Import | What it is |
| --- | --- |
| `@c9up/nova` | `Nova`, `defineConfig`, `generateVapidKeys`, `SubscriptionStore`, errors |
| `@c9up/nova/provider` | the provider — routes, container bindings |
| `@c9up/nova/services/main` | the container accessor, for sending from anywhere |
| `@c9up/nova/client` | `registerServiceWorker`, `subscribe`, `urlBase64ToUint8Array` |
| `@c9up/nova/commands` | the console commands, registered by `configure` |
| `@c9up/nova/configure` | the `configure` hook |
| `@c9up/nova/testing` | `FakeNova` |

## License

MIT
