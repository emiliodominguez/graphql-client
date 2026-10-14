import WebSocketImpl from "ws";
import { describe, expectTypeOf, it } from "vitest";
import { Client } from "./client";
import { graphql, type DocumentString } from "./document";
import { ClientError, isClientError } from "./errors";
import { optimistic } from "./optimistic";
import { useLazyQuery, useMutation, useQuery, useSubscription, useSuspenseQuery, type UseQueryResult } from "./react/index";
import type { TypedDocumentString } from "./types";
import { createWebSocketTransport } from "./ws/index";

const client = new Client({ url: "https://test.dev/graphql" });

interface User {
	user: { id: number; name: string; tags: string[] };
}

const needsId = "query { a }" as unknown as TypedDocumentString<User, { id: number }>;
const none = "query { a }" as unknown as TypedDocumentString<User, Record<string, never>>;

/* ---------------------------------------------------------------------------------------------------------------- */
/* GraphQL Code Generator (client preset, documentMode: "string") replica                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

interface DocumentTypeDecoration<TResult, TVariables> {
	__apiType?: (variables: TVariables) => TResult;
}

type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
type InputMaybe<T> = T | null | undefined;

class CodegenDocument<TResult, TVariables> extends String implements DocumentTypeDecoration<TResult, TVariables> {
	__apiType?: NonNullable<DocumentTypeDecoration<TResult, TVariables>["__apiType"]>;
	private value: string;
	public __meta__?: Record<string, unknown> | undefined;

	constructor(value: string, __meta__?: Record<string, unknown> | undefined) {
		super(value);
		this.value = value;
		this.__meta__ = __meta__;
	}

	override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
		return this.value as string & DocumentTypeDecoration<TResult, TVariables>;
	}
}

type GetUserQuery = { __typename?: "Query"; user?: { __typename?: "User"; id: string; name: string } | null };
type GetUserQueryVariables = Exact<{ id: string }>;
type ListQueryVariables = Exact<{ first?: InputMaybe<number> }>;
type NoVarsQueryVariables = Exact<{ [key: string]: never }>;

const GetUserDocument = new CodegenDocument<GetUserQuery, GetUserQueryVariables>("query GetUser($id: ID!) { a }");
const ListDocument = new CodegenDocument<GetUserQuery, ListQueryVariables>("query List($first: Int) { a }");
const NoVarsDocument = new CodegenDocument<GetUserQuery, NoVarsQueryVariables>("query NoVars { a }");

describe("codegen TypedDocumentString interop (should hold)", function () {
	it("infers data and enforces variables on the client", function () {
		expectTypeOf(client.gql({ query: GetUserDocument, variables: { id: "1" } })).resolves.toEqualTypeOf<GetUserQuery>();
		expectTypeOf(client.gql({ query: ListDocument })).resolves.toEqualTypeOf<GetUserQuery>();
		expectTypeOf(client.gql({ query: NoVarsDocument })).resolves.toEqualTypeOf<GetUserQuery>();
		// @ts-expect-error variables are required
		void client.gql({ query: GetUserDocument });
		// @ts-expect-error variables are required
		client.watch({ query: GetUserDocument });
		// @ts-expect-error variables are required
		client.subscribe({ query: GetUserDocument });
		// @ts-expect-error wrong variable type
		void client.gql({ query: GetUserDocument, variables: { id: 1 } });
	});

	it("infers data and enforces variables in hooks", function () {
		function Component(): void {
			expectTypeOf(useQuery({ query: GetUserDocument, variables: { id: "1" } }).data).toEqualTypeOf<
				GetUserQuery | undefined
			>();
			expectTypeOf(
				useSuspenseQuery({ query: GetUserDocument, variables: { id: "1" } }).data,
			).toEqualTypeOf<GetUserQuery>();
			// @ts-expect-error variables are required
			useQuery({ query: GetUserDocument });
			// @ts-expect-error variables are required
			useSuspenseQuery({ query: GetUserDocument });
			// @ts-expect-error variables are required
			useSubscription({ query: GetUserDocument });

			const [mutate] = useMutation(GetUserDocument);
			const [execute] = useLazyQuery(GetUserDocument);
			const [executeNoVars] = useLazyQuery(NoVarsDocument);

			// @ts-expect-error variables are required
			void mutate();
			// @ts-expect-error variables are required
			void execute();
			void executeNoVars();
			expectTypeOf(execute({ id: "1" })).resolves.toEqualTypeOf<GetUserQuery>();
		}

		expectTypeOf(Component).toBeFunction();
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 1: cache targets (read / write / optimistic) never require variables                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: CacheTarget ignores required variables", function () {
	it("read / write / optimistic accept a target without its required variables", function () {
		// @ts-expect-error variables are required (HOLE: compiles, reads the entry keyed by `undefined` variables)
		void client.read({ query: needsId });
		// @ts-expect-error variables are required (HOLE)
		void client.write({ query: needsId }, { user: { id: 1, name: "a", tags: [] } });
		// @ts-expect-error variables are required (HOLE)
		optimistic({ query: needsId }, function update(current) {
			return current!;
		});
		// @ts-expect-error variables are required (HOLE)
		void client.read({ query: GetUserDocument });
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 2: optimistic() infers TData from a parameterless update's return value                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: optimistic() widens TData from the update's return", function () {
	it("accepts incomplete optimistic data when the callback ignores `current`", function () {
		// write() holds: TData comes from the document.
		// @ts-expect-error `name` and `tags` are missing
		void client.write({ query: none }, { user: { id: 1 } });
		// @ts-expect-error `name` is missing
		void client.write({ query: GetUserDocument, variables: { id: "1" } }, { user: { id: "1" } });

		// @ts-expect-error `name`/`tags` missing: TData comes from the document, never from the returned value
		optimistic({ query: none }, function update() {
			return { user: { id: 1 } };
		});
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 3: explicit TData erases the document's variables (TVariables falls back to Record<string, unknown>)        */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: explicit data type argument drops required variables", function () {
	it("gql / watch / useQuery with only TData given", function () {
		// @ts-expect-error variables are required (HOLE: TVariables defaults to Record<string, unknown>)
		void client.gql<User>({ query: needsId });
		// @ts-expect-error variables are required (HOLE)
		client.watch<GetUserQuery>({ query: GetUserDocument });
		// @ts-expect-error variables are required (HOLE)
		client.subscribe<User>({ query: needsId });

		function Component(): void {
			// @ts-expect-error variables are required (HOLE)
			useQuery<GetUserQuery>({ query: GetUserDocument });
			// @ts-expect-error variables are required (HOLE)
			useSuspenseQuery<User>({ query: needsId });
			// @ts-expect-error the document requires variables (HOLE: `mutate()` below compiles)
			const [mutate] = useMutation<GetUserQuery>(GetUserDocument);
			void mutate();
		}

		expectTypeOf(Component).toBeFunction();
	});

	it("bivariant __apiType lets a document be upcast to fewer variables", function () {
		// @ts-expect-error upcast drops the required variables (HOLE: method-declared __apiType is bivariant)
		const erased: TypedDocumentString<User, {}> = needsId;
		// @ts-expect-error same through the DocumentString default (HOLE)
		const erasedTag: DocumentString<User> = needsId as DocumentString<User, { id: number }>;

		void client.gql({ query: erased });
		void client.gql({ query: erasedTag });

		// The fix: a contravariant phantom property rejects the upcast.
		interface Fixed<TData, TVariables> extends String {
			__apiType?: ((variables: TVariables) => TData) | undefined;
		}
		const strict = "" as unknown as Fixed<User, { id: number }>;
		// @ts-expect-error contravariant variables: cannot drop the requirement
		const strictErased: Fixed<User, {}> = strict;
		// @ts-expect-error contravariant variables: cannot default to Record<string, unknown>
		const strictRecord: Fixed<User, Record<string, unknown>> = strict;
		// Generic "any document" positions still work with `never` (or `any`) variables.
		const anyDocument: Fixed<unknown, never> = strict;

		void strictErased;
		void strictRecord;
		void anyDocument;
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 4: skippable variables do not require `skip`                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: WithSkippableVariables accepts undefined variables without skip", function () {
	it("useQuery / useSubscription", function () {
		function Component(id: number | undefined): void {
			// @ts-expect-error undefined variables without `skip` (HOLE: fetches with no variables)
			useQuery({ query: needsId, variables: undefined });
			// @ts-expect-error (HOLE)
			useQuery({ query: needsId, variables: id === undefined ? undefined : { id } });
			// @ts-expect-error (HOLE)
			useSubscription({ query: needsId, variables: undefined });
			// Still valid with skip:
			useQuery({ query: needsId, variables: id === undefined ? undefined : { id }, skip: id === undefined });
		}

		expectTypeOf(Component).toBeFunction();
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 5: generic wrappers cannot forward variables                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("generic wrappers over TVariables", function () {
	it("forwarding a typed document and its variables compiles", function () {
		function run<TData, TVariables extends object>(
			document: TypedDocumentString<TData, TVariables>,
			variables: TVariables,
		): Promise<TData> {
			return client.gql({ query: document, variables });
		}

		function useEntity<TData, TVariables extends object>(
			document: TypedDocumentString<TData, TVariables>,
			variables: TVariables,
		): UseQueryResult<TData, TVariables> {
			return useQuery({ query: document, variables });
		}

		function useRunner<TData, TVariables extends object>(
			document: TypedDocumentString<TData, TVariables>,
			variables: TVariables,
		): Promise<TData> {
			const [mutate] = useMutation(document);

			return mutate(variables);
		}

		expectTypeOf(run(needsId, { id: 1 })).resolves.toEqualTypeOf<User>();
		expectTypeOf(useEntity).toBeFunction();
		expectTypeOf(useRunner).toBeFunction();
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 6: union of documents                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("union of documents", function () {
	it("a conditional document keeps the required variables", function () {
		const document = Math.random() > 0.5 ? needsId : none;

		// @ts-expect-error one of the documents requires variables
		void client.gql({ query: document });
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* fetchMore                                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("fetchMore", function () {
	it("does not force `variables` for a document without variables (HOLE: valid call fails to compile)", function () {
		const ref = client.watch({ query: none });

		// Valid at runtime (`{ ...options.variables, ...undefined }`): re-fetches and merges.
		void ref.fetchMore({
			merge(previous, next) {
				return { user: { ...previous.user, tags: [...previous.user.tags, ...next.user.tags] } };
			},
		});
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 7: results are deeply frozen at runtime but typed mutable                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: frozen results are typed as mutable", function () {
	it("callbacks receiving frozen data cannot mutate it", async function () {
		// Results themselves stay typed as mutable (readonly result types would break passing them to `T[]` APIs and
		// `useState<T>`); the callbacks that receive cached data in place are readonly instead.
		const ref = client.watch({ query: none });

		void ref.fetchMore({
			variables: {},
			merge(previous, next) {
				// @ts-expect-error `previous` is frozen (HOLE: the classic in-place merge throws)
				previous.user.tags.push(...next.user.tags);
				return previous;
			},
		});

		optimistic({ query: none }, function update(current) {
			// @ts-expect-error `current` is frozen (HOLE)
			current!.user.name = "optimistic";
			return current!;
		});
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 8: isClientError narrows foreign errors                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("errors", function () {
	it("isClientError narrows any Error named ClientError (e.g. graphql-request's)", function () {
		const foreign: unknown = Object.assign(new Error("x"), { name: "ClientError" });

		if (isClientError(foreign)) {
			// Typed as always-present, `undefined` at runtime: `foreign.errors.length` throws.
			expectTypeOf(foreign.errors).toEqualTypeOf<ClientError["errors"]>();
			expectTypeOf(foreign.status).toEqualTypeOf<number>();
		}
	});

	it("onError context", function () {
		const extended = client.extend({
			onError(error, context) {
				expectTypeOf(error).toBeUnknown();
				expectTypeOf(context.type).toEqualTypeOf<"query" | "mutation" | "subscription">();
				expectTypeOf(context.variables).toBeUnknown();
			},
		});

		expectTypeOf(extended).toEqualTypeOf<Client>();
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* HOLE 9: `ws` package constructor                                                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("ws transport", function () {
	it("accepts the `ws` package as WebSocket (HOLE: documented usage fails to compile)", function () {
		const transport = createWebSocketTransport({ url: "wss://x", WebSocket: WebSocketImpl });

		expectTypeOf(transport.dispose).toBeFunction();
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Optimistic raw entries                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("HOLE: raw optimistic entries are untyped", function () {
	it("an object literal bypasses `optimistic()`", function () {
		void client.gql({
			query: needsId,
			variables: { id: 1 },
			optimistic: [
				{
					// @ts-expect-error untyped garbage written into the `needsId` entry (HOLE)
					target: { query: needsId },
					update() {
						return "garbage";
					},
				},
			],
		});
	});
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Things that should hold                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

describe("should hold", function () {
	it("hook data types", function () {
		function Component(): void {
			expectTypeOf(useQuery({ query: none }).data).toEqualTypeOf<User | undefined>();
			expectTypeOf(useSuspenseQuery({ query: none }).data).toEqualTypeOf<User>();
			expectTypeOf(useSubscription({ query: none }).data).toEqualTypeOf<User | undefined>();
			const [, lazy] = useLazyQuery(none);
			const [, mutation] = useMutation(none);

			expectTypeOf(lazy.data).toEqualTypeOf<User | undefined>();
			expectTypeOf(mutation.data).toEqualTypeOf<User | undefined>();
		}

		expectTypeOf(Component).toBeFunction();
	});

	it("mutate overrides cannot carry variables or query", function () {
		function Component(): void {
			const [mutate] = useMutation(needsId);

			// @ts-expect-error variables are not an override
			void mutate({ id: 1 }, { variables: {} });
			// @ts-expect-error query is not an override
			void mutate({ id: 1 }, { query: "{ b }" });
		}

		expectTypeOf(Component).toBeFunction();
	});

	it("graphql tag", function () {
		const document = graphql<User, { id: number }>`
			query {
				a
			}
		`;

		// @ts-expect-error variables are required
		void client.gql({ query: document });
		expectTypeOf(
			client.gql({
				query: graphql`
					{
						a
					}
				`,
			}),
		).resolves.toBeUnknown();
	});

	it("DocumentNode objects are rejected", function () {
		const node = { kind: "Document", definitions: [] };

		// @ts-expect-error not a string document
		void client.gql({ query: node });
	});
});
