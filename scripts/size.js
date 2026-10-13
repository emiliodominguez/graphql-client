import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { transformSync } from "esbuild";

const FILES = ["dist/index.js", "dist/index.cjs"];

/**
 * Maximum min+gzip size of the ESM bundle, in bytes. CI fails above it.
 */
const BUDGET = 4.5 * 1024;

/**
 * Prints the minified, gzip and brotli sizes of the built bundles (what consumers actually ship)
 * and fails when the ESM bundle exceeds the budget.
 */
function main() {
	for (const file of FILES) {
		const { code } = transformSync(readFileSync(file, "utf8"), { minify: true, loader: "js" });
		const minified = Buffer.from(code);
		const gzip = gzipSync(minified, { level: 9 }).length;

		console.log(
			[
				file.padEnd(16),
				`${format(minified.length)} min`,
				`${format(gzip)} gzip`,
				`${format(brotliCompressSync(minified).length)} brotli`,
			].join("  "),
		);

		if (file.endsWith(".js") && gzip > BUDGET) {
			console.error(`\nSize budget exceeded: ${format(gzip)} > ${format(BUDGET)} (min+gzip)`);
			process.exitCode = 1;
		}
	}
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
