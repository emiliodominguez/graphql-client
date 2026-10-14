import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { containsFiles, createUploadBody, extractFiles } from "./upload";

/**
 * Normalizes the arguments `fetch` was called with into a Request (the client calls `fetch(url, init)`).
 *
 * @param input - The URL or request
 * @param init - The request init
 * @returns The request
 */
function toRequest(input: RequestInfo | URL, init?: RequestInit): Request {
	return input instanceof Request ? input : new Request(input, init);
}

describe("extractFiles", function () {
	it("replaces files with null and records every path", function () {
		const avatar = new File(["a"], "avatar.png");
		const doc = new Blob(["b"]);
		const files = new Map<Blob, string[]>();
		const clone = extractFiles({ input: { avatar, docs: [doc, avatar] }, date: new Date(0), n: 1 }, files);

		expect(clone).toEqual({ input: { avatar: null, docs: [null, null] }, date: new Date(0), n: 1 });
		expect([...files]).toEqual([
			[avatar, ["variables.input.avatar", "variables.input.docs.1"]],
			[doc, ["variables.input.docs.0"]],
		]);
	});

	it("returns nothing for file-less values", function () {
		const files = new Map<Blob, string[]>();

		expect(extractFiles({ a: [1, "x"] }, files)).toEqual({ a: [1, "x"] });
		expect(files.size).toBe(0);
		expect(createUploadBody({ variables: { a: 1 } })).toBeUndefined();
		expect(createUploadBody({})).toBeUndefined();
	});
});

describe("uploads", function () {
	it("sends a multipart request per the GraphQL multipart request spec", async function () {
		const fetchMock = vi.fn<typeof fetch>(async function () {
			return Response.json({ data: { upload: true } });
		});
		const client = new Client({ url: "https://test.dev/graphql", fetch: fetchMock, method: "GET" });
		const file = new File(["hello"], "hello.txt", { type: "text/plain" });
		const query = "mutation Upload($file: Upload!) { upload(file: $file) }";

		await client.gql({ query, variables: { file } });

		const request = toRequest(...fetchMock.mock.calls[0]!);
		const form = await request.formData();
		const uploaded = form.get("0") as File;

		expect(request.method).toBe("POST");
		expect(request.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
		expect(JSON.parse(String(form.get("operations")))).toEqual({ query, variables: { file: null } });
		expect(JSON.parse(String(form.get("map")))).toEqual({ 0: ["variables.file"] });
		expect(uploaded.name).toBe("hello.txt");
		expect(await uploaded.text()).toBe("hello");
	});

	it("names anonymous blobs", function () {
		const form = createUploadBody({ variables: { file: new Blob(["x"]) } })!;

		expect((form.get("0") as File).name).toBe("blob");
	});
});

describe("containsFiles", function () {
	it("finds files exactly where extractFiles does", function () {
		const file = new Blob(["x"]);
		const values: unknown[] = [
			undefined,
			null,
			file,
			{ a: [{ b: file }] },
			[1, [2, [file]]],
			{ a: 1, b: [2, { c: "d" }] },
			new Map([["file", file]]),
			Object.assign(Object.create({ inherited: file }) as object, { own: 1 }),
		];

		for (const value of values) {
			const files = new Map<Blob, string[]>();

			extractFiles(value, files);
			expect(containsFiles(value)).toBe(files.size > 0);
		}
	});
});

describe("createUploadBody", function () {
	it("keeps a __proto__ variable as a regular key", function () {
		const variables = JSON.parse('{"__proto__":{"note":"kept"}}') as Record<string, unknown>;

		variables.file = new Blob(["x"]);

		const operations = JSON.parse(String(createUploadBody({ variables })!.get("operations")));

		expect(operations.variables).toEqual(JSON.parse('{"__proto__":{"note":"kept"},"file":null}'));
	});
});
