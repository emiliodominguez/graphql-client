import { isObject } from "./utils";

/**
 * Checks whether a value is a file-like `Blob` (including `File`).
 *
 * @param value - Any value
 * @returns `true` for Blob instances
 */
function isFile(value: unknown): value is Blob {
	return typeof Blob !== "undefined" && value instanceof Blob;
}

/**
 * Checks whether a value is an object literal, the only objects (besides arrays) scanned for files.
 *
 * @param value - Any value
 * @returns `true` for objects whose prototype is `Object.prototype`
 */
function isObjectLiteral(value: unknown): value is Record<string, unknown> {
	return isObject(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Recursively replaces files with `null` and records their paths, per the GraphQL multipart request spec.
 * Only object literals and arrays are traversed.
 *
 * @param value - The value to scan (usually the operation variables)
 * @param files - Accumulator of each file mapped to every object path it appeared at
 * @param path - The object path of `value`
 * @returns A clone of `value` with every file replaced by `null`
 */
export function extractFiles(value: unknown, files: Map<Blob, string[]>, path = "variables"): unknown {
	if (isFile(value)) {
		files.set(value, [...(files.get(value) ?? []), path]);

		return null;
	}

	if (Array.isArray(value)) {
		return value.map(function extractItem(item: unknown, index: number): unknown {
			return extractFiles(item, files, `${path}.${index}`);
		});
	}

	if (!isObjectLiteral(value)) return value;

	// Null prototype: a `__proto__` key stays a regular property.
	const clone: Record<string, unknown> = Object.create(null);

	for (const key of Object.keys(value)) {
		// Spec paths are dot-separated without escaping: the server would look for the file elsewhere.
		if (key.includes(".") && containsFiles(value[key])) {
			throw new TypeError(`Cannot upload files under "${path}.${key}": keys on a file path cannot contain dots.`);
		}

		clone[key] = extractFiles(value[key], files, `${path}.${key}`);
	}

	return clone;
}

/**
 * Checks whether a value contains a file anywhere {@link extractFiles} would find one, without cloning it.
 *
 * @param value - The value to scan (usually the operation variables)
 * @returns `true` when at least one file is present
 */
export function containsFiles(value: unknown): boolean {
	return (
		isFile(value) ||
		(Array.isArray(value) ? value : isObjectLiteral(value) ? Object.values(value) : []).some(containsFiles)
	);
}

/**
 * Builds a multipart request body (`operations`, `map`, then one field per file) when variables contain files.
 *
 * @see https://github.com/jaydenseric/graphql-multipart-request-spec
 * @param payload - The GraphQL payload
 * @returns The FormData body, or `undefined` when there are no files
 */
export function createUploadBody(payload: { variables?: unknown }): FormData | undefined {
	const files = new Map<Blob, string[]>();
	const clone = extractFiles(payload.variables, files);

	if (files.size === 0) return undefined;

	const form = new FormData();
	const map: Record<string, string[]> = {};
	let index = 0;

	form.set("operations", JSON.stringify({ ...payload, variables: clone }));

	for (const paths of files.values()) map[index++] = paths;

	form.set("map", JSON.stringify(map));
	index = 0;

	for (const file of files.keys()) {
		form.set(String(index++), file, (file as File).name || "blob");
	}

	return form;
}
