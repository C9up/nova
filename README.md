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

Subscriptions live behind a `SubscriptionStore`. Which one an application uses
is named in the config, the way the other packages name a pluggable backend —
so the environment picks it, and no file changes between deployments:

```ts
// config/nova.ts
import { defineConfig, stores } from '@c9up/nova'
import env from '#start/env'

export default defineConfig({
  default: env.get('NOVA_STORE'),
  stores: {
    memory: stores.memory(),
    file:   stores.file({ path: 'storage/push_subscriptions.json' }),
    sql:    stores.sql({ connection: () => app.container.resolve('db') }),
    redis:  stores.redis({ connection: 'main' }),
  },
})
```

Factories are lazy: only the store actually selected is built, so naming a Redis
store in a config that runs on the file store opens no connection. A `default`
that names nothing throws — falling back to memory would look like it worked
until a restart lost every subscription.

| Store | Keeps them | Use it when |
| --- | --- | --- |
| `stores.memory()` | until the process exits | tests, and a dev machine with nothing set up |
| `stores.sql({ connection })` | in the `push_subscriptions` table | you already have a database |
| `stores.redis({ connection })` | in Redis, under `nova:push:*` | you already run Redis for a cache or a queue |
| `stores.file({ path })` | in one JSON file | one process, and neither of the above |

### SQL

`configure` writes the migration that creates the table. `connection` takes the
connection, or a function answering one — which is what a config file needs,
since it is read before the application boots:

```ts
sql: stores.sql({ connection: () => app.container.resolve('db') })
```

Any connection answering `execute`, `query` and its `dialect` fits — nova does
not depend on a database package. Pass `table` if you renamed the table.

### Redis

```ts
redis: stores.redis({ connection: 'main' })
```

A `@c9up/quasar` connection name, resolved when the store is first used — nova
never imports quasar, which stays optional, and says so plainly if it is absent.
Pass a client (or a function answering one) instead to use any ioredis- or
node-redis-shaped client. Keys are prefixed `nova:push`; pass `prefix` to run
two applications against one database.

Durability is the server's: a Redis with no persistence loses subscriptions on
restart. Browsers re-subscribe on their next visit, so the cost is a missed
notification rather than a broken account — but if that is not acceptable, use a
persistent Redis or the SQL store.

### A file

```ts
file: stores.file({ path: 'storage/push_subscriptions.json' })
```

Nothing to install and nothing to run. The file is written to a temporary path
and renamed over the real one, so a crash mid-write leaves the previous file
rather than a truncated one, and writes are serialised so a burst of subscribes
cannot overwrite each other.

**One process.** Two processes writing the same file overwrite each other —
nothing here takes a lock the operating system enforces. Behind a cluster,
`pm2 -i`, or several containers, use SQL or Redis.

A file it cannot parse is refused rather than treated as empty: starting from
empty would replace your subscriptions on the next subscribe, and the only
symptom would be notifications that stop arriving.

### Your own

```ts
export interface SubscriptionStore {
  save(userId: string, subscription: PushSubscription): Promise<void>
  listByUser(userId: string): Promise<PushSubscription[]>
  delete(endpoint: string): Promise<void>
}
```

Wrap it in a factory and it is a store like any other:
`mine: () => new MySubscriptionStore()`.

One rule matters, and all four shipped stores follow it: `save` detaches the
endpoint from its previous owner. A push endpoint is globally unique per push
service, so a browser reused across a logout/login pair would otherwise stay
attached to both accounts — and the next notification for the old one would
land on the new user's screen.

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
| `@c9up/nova` | `Nova`, `defineConfig`, `stores`, `generateVapidKeys`, the store classes, errors |
| `@c9up/nova/provider` | the provider — routes, container bindings |
| `@c9up/nova/services/main` | the container accessor, for sending from anywhere |
| `@c9up/nova/client` | `registerServiceWorker`, `subscribe`, `urlBase64ToUint8Array` |
| `@c9up/nova/commands` | the console commands, registered by `configure` |
| `@c9up/nova/configure` | the `configure` hook |
| `@c9up/nova/testing` | `FakeNova` |

## License

MIT
