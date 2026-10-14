import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts", react: "src/react/index.ts", ws: "src/ws/index.ts" },
	format: ["esm", "cjs"],
	target: "es2020",
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: ["react"],
});
