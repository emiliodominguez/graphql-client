import { describe, expectTypeOf, it } from "vitest";
import { Client } from "./client";
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
