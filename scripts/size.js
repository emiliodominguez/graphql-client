import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { buildSync, transformSync } from "esbuild";

/**
 * Maximum min+gzip size of a typical app import (`Client` + `MemoryCache`, tree-shaken), in bytes. CI fails above it.
 */
const BUDGET = 6.5 * 1024;

/**
 * What a typical app imports.
 */
const TYPICAL_IMPORT = 'import { Client, MemoryCache } from "./dist/index.js"; console.log(Client, MemoryCache);';

/**
 * Prints minified, gzip and brotli sizes for the full bundles and for a tree-shaken typical import,
 * and fails when the typical import exceeds the budget.
 */
function main() {
	for (const file of ["dist/index.js", "dist/index.cjs", "dist/react.js", "dist/ws.js"]) {
		report(file, transformSync(readFileSync(file, "utf8"), { minify: true, loader: "js" }).code);
	}

	const { outputFiles } = buildSync({
		stdin: { contents: TYPICAL_IMPORT, resolveDir: process.cwd(), loader: "js" },
		bundle: true,
		minify: true,
		format: "esm",
		write: false,
		external: ["react"],
	});
	const gzip = report("Client + MemoryCache", outputFiles[0].text);

	if (gzip > BUDGET) {
		console.error(`\nSize budget exceeded: ${format(gzip)} > ${format(BUDGET)} (min+gzip)`);
		process.exitCode = 1;
	}
}

/**
 * Prints the sizes of a minified bundle.
 *
 * @param {string} label - Row label
 * @param {string} code - Minified code
 * @returns {number} The gzip size in bytes
 */
function report(label, code) {
	const minified = Buffer.from(code);
	const gzip = gzipSync(minified, { level: 9 }).length;

	console.log(
		[
			label.padEnd(22),
			`${format(minified.length)} min`,
			`${format(gzip)} gzip`,
			`${format(brotliCompressSync(minified).length)} brotli`,
		].join("  "),
	);

	return gzip;
}

/**
 * Formats a byte count as kilobytes.
 *
 * @param {number} bytes - Byte count
 * @returns {string} The formatted size
 */
function format(bytes) {
	return `${(bytes / 1024).toFixed(2)} kB`;
}

main();
