import type { TypedDocumentString } from "./types";

/**
 * A GraphQL document produced by {@link graphql}: a plain string at runtime, typed at compile time.
 *
 * @template TData - The shape of the `data` field in the response
 * @template TVariables - The shape of the operation variables
 */
export type DocumentString<TData = unknown, TVariables = Record<string, unknown>> = string &
	TypedDocumentString<TData, TVariables>;

/**
 * Tokens the lexer must keep verbatim (strings) or drop (comments).
 */
const TOKENS = /"""(?:\\"""|[\s\S])*?"""|"(?:[^"\\\n\r]|\\.)*"|#[^\n\r]*|[\s,]+|[^"#\s,]+/g;

/**
 * Characters that need a separating space when adjacent (names, numbers, variables, negative numbers).
 */
const WORD = /[\w$-]/;

/**
 * Template tag for GraphQL documents. Interpolate fragments (or any document) and duplicated fragment
 * definitions are removed, so composing fragments that share dependencies just works.
 * Pass type arguments to get typed documents without code generation.
 *
 * @example
 * const USER_FIELDS = graphql`fragment UserFields on User { id name }`;
 * const GET_USER = graphql<{ user: User }, { id: string }>`
 *   query GetUser($id: ID!) { user(id: $id) { ...UserFields } }
 *   ${USER_FIELDS}
 * `;
 *
 * @template TData - The shape of the `data` field in the response
 * @template TVariables - The shape of the operation variables
 * @param strings - Template literal chunks
 * @param fragments - Interpolated documents
 * @returns The composed document
 */
export function graphql<TData = unknown, TVariables = Record<string, unknown>>(
	strings: TemplateStringsArray,
	...fragments: ReadonlyArray<string | TypedDocumentString<unknown, unknown>>
): DocumentString<TData, TVariables> {
	let source = strings[0] ?? "";

	for (let index = 0; index < fragments.length; index++) {
		source += String(fragments[index]) + (strings[index + 1] ?? "");
	}

	return dedupeFragments(source) as DocumentString<TData, TVariables>;
}

/**
 * Splits a document into its top-level definitions and drops repeated fragment definitions (first one wins).
 *
 * @param document - The GraphQL document
 * @returns The document with unique fragment definitions
 */
export function dedupeFragments(document: string): string {
	const definitions: string[] = [];
	const seen = new Set<string>();
	let depth = 0;
	let parens = 0;
	let current = "";

	for (const [token] of document.matchAll(TOKENS)) {
		current += token;

		if (token.startsWith('"') || token.startsWith("#")) continue;

		for (const char of token) {
			if (char === "(") parens++;
			else if (char === ")") parens--;
			// Braces inside arguments are object values, not selection sets.
			else if (parens > 0) continue;
			else if (char === "{") depth++;
			else if (char === "}" && --depth === 0) {
				definitions.push(current.trim());
				current = "";
			}
		}
	}

	const unique = definitions.filter(function isFirstDefinition(definition: string): boolean {
		const name = /^(?:#[^\n\r]*\s*)*fragment\s+([_A-Za-z]\w*)/.exec(definition)?.[1];

		if (!name) return true;
		if (seen.has(name)) return false;

		seen.add(name);
		return true;
	});

	return [...unique, current.trim()].filter(Boolean).join("\n\n");
}

/**
 * Minifies a GraphQL document: strips comments, insignificant whitespace and commas, and preserves strings.
 * Smaller payloads and shorter GET URLs, with identical semantics.
 *
 * @param document - The GraphQL document
 * @returns The minified document
 */
export function minify<T extends string | TypedDocumentString<unknown, unknown>>(document: T): T {
	let output = "";
	let pendingSpace = false;

	for (const [token] of String(document).matchAll(TOKENS)) {
		if (token.startsWith("#")) continue;

		if (/^[\s,]/.test(token)) {
			pendingSpace = true;
			continue;
		}

		const previous = output.at(-1) ?? "";
		const first = token[0]!;

		// Adjacent names/numbers need a separator, and so do adjacent strings: `""` + `"x"` would read as `"""`.
		if ((pendingSpace && WORD.test(previous) && WORD.test(first)) || (previous === '"' && first === '"')) output += " ";

		output += token;
		pendingSpace = false;
	}

	return output as T;
}
