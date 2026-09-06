import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// `src/vendor/**` is generated from scripts/vendor/ and identical in every
			// package that carries it, so measuring it here counts the same lines N
			// times and holds this package to a floor for code it cannot change. The
			// behaviour is pinned where it broke: bay's quasar-bridge suite covers the
			// two manager shapes the loader has to accept.
			exclude: ["src/**/*.d.ts", "src/vendor/**"],
			reporter: ["text-summary", "json-summary"],
			// Set just under what the suite actually reaches, so the gate can
			// only be crossed downwards on purpose — and run by CI, without
			// which a threshold is the same as an absent one.
			thresholds: {
				lines: 94,
				statements: 92,
				branches: 88,
				functions: 96,
			},
		},
	},
});
