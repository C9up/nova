import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

/**
 * Service Worker template scaffolded by `ream configure @c9up/nova` (story 48.4).
 *
 * Written to `public/sw.js` so the on-boarding promise of 48.1
 * (`registerServiceWorker('/sw.js')`) resolves against a real file. Inlined
 * (string literal, not a separate `templates/sw.js`) — same precedent as the
 * `config/nova.ts` template below and `@c9up/photon`'s `configure.ts`. The
 * source is browser JS (classic script — 48.1 registers without
 * `type: 'module'`), so no `import` / `export` keywords appear inside.
 *
 * `userVisibleOnly: true` (set by `@c9up/nova/client` `subscribe()`) means
 * the SW MUST call `showNotification` on every push or the browser revokes
 * the subscription — every parse/error path therefore falls back to a
 * generic notification rather than letting an exception propagate out of
 * the listener.
 */
export const SW_TEMPLATE = `// Service Worker scaffolded by \`ream configure @c9up/nova\` (story 48.4).
//
// Lifecycle: \`skipWaiting\` + \`clients.claim\` so the first push that arrives
// after subscription is delivered through this SW (not dropped in the
// install→activate race window).
//
// Push handler: parse the JSON payload sent by
// \`nova.push(sub, { title, body, icon, url, tag, data })\` and display a
// notification. \`userVisibleOnly: true\` (set by @c9up/nova/client
// \`subscribe()\`) means we MUST call \`showNotification\` on every push or
// the browser revokes the subscription — every parse/error path falls back
// to a generic notification rather than throwing out of the listener.
//
// Notificationclick: close the notification, then focus an existing tab
// whose URL matches \`data.url\` (preferring visible/focused tabs), falling
// back to opening a new window. URL comparison normalises the inbound
// path against the SW origin.
//
// Registered from the app via \`registerServiceWorker('/sw.js')\` from
// \`@c9up/nova/client\`. Edit freely — re-running \`ream configure @c9up/nova\`
// will NOT overwrite this file.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  if (!event.data) return
  let payload = {}
  try {
    const parsed = event.data.json()
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed
    }
  } catch {
    try {
      payload = { title: event.data.text() }
    } catch {
      payload = {}
    }
  }
  const { title = 'Notification', body, icon, url, tag, data } = payload
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      tag,
      data: { ...(data ?? {}), ...(url !== undefined ? { url } : {}) },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url
  if (!target) return
  const targetURL = new URL(target, self.location.origin).href
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const matches = clients
          .filter((client) => client.url === targetURL)
          .sort((a, b) => {
            const aVisible = a.visibilityState === 'visible' ? 0 : 1
            const bVisible = b.visibilityState === 'visible' ? 0 : 1
            if (aVisible !== bVisible) return aVisible - bVisible
            return (b.focused === true ? 1 : 0) - (a.focused === true ? 1 : 0)
          })
        if (matches.length > 0) {
          return matches[0]
            .focus()
            .catch(() => self.clients.openWindow(targetURL).catch(() => {}))
        }
        return self.clients.openWindow(targetURL).catch(() => {})
      }),
  )
})
`;

/**
 * Resolve the path of the migration template shipped at the package root
 * (`packages/nova/migrations/create_push_subscriptions.ts`). Working from
 * `import.meta.url` keeps the resolution stable across the workspace
 * (symlinked) and a published-tarball install (where `src/` and
 * `migrations/` keep their relative layout per the package's `files`
 * include list).
 */
async function readMigrationTemplate(): Promise<string> {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const migrationPath = path.resolve(
		here,
		"..",
		"migrations",
		"create_push_subscriptions.ts",
	);
	return readFile(migrationPath, "utf8");
}

export async function configure(codemods: Codemods): Promise<void> {
	// Read the migration template FIRST — fail-fast before any side effect on
	// the user's project. If the package's `migrations/` is missing or
	// unreadable (corrupt install, pruned tarball, EISDIR/EACCES on a weird
	// volume), abort here so the user is not left with a half-configured
	// project (provider registered + .env stubbed + config/nova.ts written
	// but no migration).
	const migrationContent = await readMigrationTemplate();

	await codemods.addProvider("@c9up/nova/provider");
	await codemods.addEnvVars({
		NOVA_VAPID_PUBLIC_KEY: "",
		NOVA_VAPID_PRIVATE_KEY: "",
		NOVA_VAPID_SUBJECT: "mailto:noreply@localhost",
	});
	await codemods.writeFile(
		"config/nova.ts",
		`import { defineConfig } from '@c9up/nova'
import env from '#start/env'

// Run \`ream nova:vapid:generate\` to mint a VAPID key pair into .env.

export default defineConfig({
  routePrefix: '/api/nova',
  guard: 'jwt',
  vapid: {
    publicKey: env.get('NOVA_VAPID_PUBLIC_KEY'),
    privateKey: env.get('NOVA_VAPID_PRIVATE_KEY'),
    subject: env.get('NOVA_VAPID_SUBJECT'),
  },
})
`,
	);

	// 48.3 — Atlas durable driver migration template.
	//
	// `writeFile` is idempotent on the exact path (createCodemods returns
	// early when the target already exists and `force` is unset), so re-runs
	// are safe. The Codemods API does NOT expose a glob/list so the filename
	// is stable rather than timestamp-prefixed-by-app-convention; users who
	// prefer their own prefix style can rename the file post-write.
	await codemods.writeFile(
		"database/migrations/0048_create_push_subscriptions.ts",
		migrationContent,
	);

	// 48.4 — Service Worker scaffold.
	//
	// Inlined string constant (`SW_TEMPLATE` above) so no fail-fast read step
	// is needed; the template cannot fail at runtime. Idempotent on path:
	// re-running configure preserves user edits to `public/sw.js` (same
	// contract as `config/nova.ts` and the migration template above).
	await codemods.writeFile("public/sw.js", SW_TEMPLATE);
}
