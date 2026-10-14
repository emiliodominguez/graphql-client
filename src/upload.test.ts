import { describe, expect, it, vi } from "vitest";
import { Client } from "./client";
import { createUploadBody, extractFiles } from "./upload";

describe("extractFiles", function () {
	it("replaces files with null and records every path", function () {
		const avatar = new File(["a"], "avatar.png");
		const doc = new Blob(["b"]);
		const { clone, files } = extractFiles({ input: { avatar, docs: [doc, avatar] }, date: new Date(0), n: 1 });

		expect(clone).toEqual({ input: { avatar: null, docs: [null, null] }, date: new Date(0), n: 1 });
		expect([...files]).toEqual([
			[avatar, ["variables.input.avatar", "variables.input.docs.1"]],
			[doc, ["variables.input.docs.0"]],
		]);
	});

	it("returns nothing for file-less values", function () {
		expect(extractFiles({ a: [1, "x"] }).files.size).toBe(0);
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

		const request = fetchMock.mock.calls[0]![0] as Request;
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
