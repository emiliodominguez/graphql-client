import { describe, expectTypeOf, it } from "vitest";
import { Client } from "./client";
import { graphql } from "./document";
import { useMutation, useQuery } from "./react/index";
import type { TypedDocumentString } from "./types";

const client = new Client({ url: "https://test.dev/graphql" });

interface User {
	user: { id: number; name: string };
}

interface UserVariables {
	id: number;
}

describe("Client.gql types", function () {
	it("defaults data to unknown for plain strings", function () {
		expectTypeOf(client.gql({ query: "{ a }" })).resolves.toBeUnknown();
	});

	it("accepts an explicit data type", function () {
		expectTypeOf(client.gql<User>({ query: "{ a }", variables: { id: 1 } })).resolves.toEqualTypeOf<User>();
	});

	it("accepts interfaces as variables", function () {
		const variables: UserVariables = { id: 1 };

		expectTypeOf(client.gql<User, UserVariables>({ query: "{ a }", variables })).resolves.toEqualTypeOf<User>();
	});

	it("infers data and variables from typed documents", function () {
		const document = "query { a }" as unknown as TypedDocumentString<User, UserVariables>;

		expectTypeOf(client.gql({ query: document, variables: { id: 1 } })).resolves.toEqualTypeOf<User>();

		// @ts-expect-error variables must match the document
		client.gql({ query: document, variables: { id: "1" } });
	});
});

describe("graphql tag types", function () {
	it("infers data and variables from tagged documents", function () {
		const document = graphql<User, UserVariables>`
			query {
				a
			}
		`;

		expectTypeOf(client.gql({ query: document, variables: { id: 1 } })).resolves.toEqualTypeOf<User>();
		expectTypeOf(document).toMatchTypeOf<string>();

		// @ts-expect-error variables must match the document
		client.gql({ query: document, variables: { id: "1" } });
	});
});

describe("required variables", function () {
	const needsId = "query { a }" as unknown as TypedDocumentString<User, { id: number }>;
	const optional = "query { a }" as unknown as TypedDocumentString<User, { first?: number }>;
	const none = "query { a }" as unknown as TypedDocumentString<User, Record<string, never>>;

	it("are enforced when the document declares them", function () {
		// @ts-expect-error variables are required
		client.gql({ query: needsId });
		// @ts-expect-error variables are required
		client.watch({ query: needsId });
		// @ts-expect-error variables are required
		client.subscribe({ query: needsId });

		expectTypeOf(client.gql({ query: needsId, variables: { id: 1 } })).resolves.toEqualTypeOf<User>();
	});

	it("stay optional for optional or absent variables and plain strings", function () {
		expectTypeOf(client.gql({ query: optional })).resolves.toEqualTypeOf<User>();
		expectTypeOf(client.gql({ query: none })).resolves.toEqualTypeOf<User>();
		expectTypeOf(client.gql({ query: "{ a }" })).resolves.toBeUnknown();
	});

	it("are enforced by React hooks and mutate functions", function () {
		/**
		 * Type-only checks; never rendered.
		 */
		function Component(): void {
			// @ts-expect-error variables are required
			useQuery({ query: needsId });
			useQuery({ query: needsId, variables: { id: 1 } });
			useQuery({ query: optional });

			const [mutate] = useMutation(needsId);
			const [mutateOptional] = useMutation(optional);

			// @ts-expect-error variables are required
			void mutate();
			void mutate({ id: 1 });
			void mutateOptional();
		}

		expectTypeOf(Component).toBeFunction();
	});
});

describe("required variables (review 3)", function () {
	const union = "query { a }" as unknown as TypedDocumentString<User, { id: number } | { slug: string }>;
	const needsId = "query { a }" as unknown as TypedDocumentString<User, { id: number }>;

	it("checks union variables and rejects undefined", function () {
		// @ts-expect-error a union member requires variables
		client.gql({ query: union });
		client.gql({ query: union, variables: { slug: "x" } });
		// @ts-expect-error undefined cannot satisfy required variables
		client.gql({ query: needsId, variables: undefined });
	});

	it("allows possibly-undefined variables on skippable hooks", function () {
		/**
		 * Type-only checks; never rendered.
		 *
		 * @param id - An optional id
		 */
		function Component(id: number | undefined): void {
			useQuery({ query: needsId, variables: id === undefined ? undefined : { id }, skip: id === undefined });
		}

		expectTypeOf(Component).toBeFunction();
	});
});
