import { describe, expect, it } from "vitest";
import { dedupeFragments, graphql, minify } from "./document";

const USER_FIELDS = graphql`
	fragment UserFields on User {
		id
		name
	}
`;

const FRIENDS = graphql`
	fragment Friends on User {
		friends {
			...UserFields
		}
	}
	${USER_FIELDS}
`;

describe("graphql", function () {
	it("returns a plain string", function () {
		// prettier-ignore
		const document = graphql`{ a }`;

		expect(typeof document).toBe("string");
		expect(document).toBe("{ a }");
	});

	it("interpolates fragments and dedupes shared dependencies", function () {
		const document = graphql`
			query GetUser {
				user {
					...UserFields
					...Friends
				}
			}
			${USER_FIELDS}
			${FRIENDS}
		`;

		expect(document.match(/fragment UserFields/g)).toHaveLength(1);
		expect(document.match(/fragment Friends/g)).toHaveLength(1);
		expect(document.startsWith("query GetUser")).toBe(true);
	});
});

describe("dedupeFragments", function () {
	it("ignores braces inside strings and comments", function () {
		const document = 'fragment A on T { a(s: "}") # }\n b }\nfragment A on T { a(s: "}") # }\n b }\nquery { ...A }';

		expect(dedupeFragments(document)).toBe('fragment A on T { a(s: "}") # }\n b }\n\nquery { ...A }');
	});

	it("keeps trailing content and anonymous operations", function () {
		expect(dedupeFragments("{ a }")).toBe("{ a }");
		expect(dedupeFragments("")).toBe("");
	});
});

describe("minify", function () {
	it("strips comments, whitespace and commas", function () {
		const document = `
			# Fetch a user
			query GetUser($id: ID!, $first: Int = 10) {
				user(id: $id) {
					id, name
					... on Admin { role }
					...UserFields
					posts(first: $first) @include(if: true) { id }
				}
			}
		`;

		expect(minify(document)).toBe(
			"query GetUser($id:ID!$first:Int=10){user(id:$id){id name...on Admin{role}...UserFields posts(first:$first)@include(if:true){id}}}",
		);
	});

	it("preserves strings, block strings and separated numbers", function () {
		expect(minify('{ a(s: "x  ,  # y", b: """  multi\n  line  """, list: [1, -2, 3.5]) }')).toBe(
			'{a(s:"x  ,  # y"b:"""  multi\n  line  """list:[1 -2 3.5])}',
		);
	});

	it("is idempotent", function () {
		const once = minify(String(FRIENDS));

		expect(minify(once)).toBe(once);
	});
});
