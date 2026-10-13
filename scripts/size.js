import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { transformSync } from "esbuild";

const FILES = ["dist/index.js", "dist/index.cjs"];

/**
 * Prints the minified, gzip and brotli sizes of the built bundles — what consumers actually ship.
 */
function main() {
	for (const file of FILES) {
		const { code } = transformSync(readFileSync(file, "utf8"), { minify: true, loader: "js" });
		const minified = Buffer.from(code);

		console.log(
			[
				file.padEnd(16),
				`${format(minified.length)} min`,
				`${format(gzipSync(minified, { level: 9 }).length)} gzip`,
				`${format(brotliCompressSync(minified).length)} brotli`,
			].join("  "),
		);
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
