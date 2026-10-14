/**
 * Result of {@link extractFiles}.
 */
export interface ExtractedFiles {
	/** The input with every file replaced by `null` */
	clone: unknown;
	/** Each file mapped to every object path it appeared at */
	files: Map<Blob, string[]>;
}

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
 * Recursively replaces files with `null` and records their paths, per the GraphQL multipart request spec.
 * Only plain objects and arrays are traversed.
 *
 * @param value - The value to scan (usually the operation variables)
 * @param path - The object path of `value`
 * @param files - Accumulator of files to paths
 * @returns The clone and the extracted files
 */
export function extractFiles(value: unknown, path = "variables", files = new Map<Blob, string[]>()): ExtractedFiles {
	if (isFile(value)) {
		files.set(value, [...(files.get(value) ?? []), path]);

		return { clone: null, files };
	}

	if (Array.isArray(value)) {
		const clone = value.map(function extractItem(item: unknown, index: number): unknown {
			return extractFiles(item, `${path}.${index}`, files).clone;
		});

		return { clone, files };
	}

	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const clone: Record<string, unknown> = {};

		for (const [key, item] of Object.entries(value)) {
			clone[key] = extractFiles(item, `${path}.${key}`, files).clone;
		}

		return { clone, files };
	}

	return { clone: value, files };
}

/**
 * Builds a multipart request body (`operations`, `map`, then one field per file) when variables contain files.
 *
 * @see https://github.com/jaydenseric/graphql-multipart-request-spec
 * @param payload - The GraphQL payload
 * @returns The FormData body, or `undefined` when there are no files
 */
export function createUploadBody(payload: { variables?: unknown }): FormData | undefined {
	const { clone, files } = extractFiles(payload.variables);

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
