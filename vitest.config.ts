import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
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
