/**
 * Teach ream's `ContainerBindings` what `container.resolve(...)` returns for
 * the tokens nova binds.
 *
 * ream declares that interface open on purpose: it registers its own entries
 * and expects each package to contribute the ones it owns. Without these,
 * resolving by the string token answered `unknown`, and every call site had to
 * assert a type it could not prove.
 *
 * Loaded from the package barrel and from the provider, so registering nova is
 * enough — an application writes no `declare module` of its own.
 *
 * Type-only, and ream stays an OPTIONAL peer: nothing here reaches a runtime
 * import.
 */

// Referenced so the augmentation below resolves the module it augments.
import type {} from "@c9up/ream/types";
import type { Nova } from "./Nova.js";
import type { SubscriptionStore } from "./SubscriptionStore.js";

declare module "@c9up/ream/types" {
	interface ContainerBindings {
		/** The push sender, bound by `NovaProvider`. */
		"nova.push": Nova;
		/** The subscription store the push sender and the routes use. */
		"nova.subscriptions": SubscriptionStore;
		/**
		 * Compatibility alias: the push sender under the name it had before the
		 * token carried its package. Kept bound so an existing
		 * `container.resolve(...)` resolves; new code resolves `nova.push`.
		 */
		nova: Nova;
		/** The store under its earlier name, kept bound for the same reason. */
		SubscriptionStore: SubscriptionStore;
	}
}
