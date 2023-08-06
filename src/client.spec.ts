import Client from "./client";

// Mock the fetch function
(global.fetch as jest.Mock) = jest.fn();

describe("Client", () => {
	jest.spyOn(console, "error").mockImplementation(jest.fn);

	beforeEach(() => {
		(global.fetch as jest.Mock).mockClear();
	});

	it("should perform a GraphQL query and return data from the server", async () => {
		// Given
		const responsePayload = {
			data: { user: { id: 123, name: "John" } },
		};

		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: true,
			json: async () => responsePayload,
		});

		const clientConfig = {
			graphUrl: "https://test.com/graphql",
			authToken: "JWT123",
		};

		const client = new Client(clientConfig);

		const query = /* GraphQL */ `
			query GetUser($id: Int!) {
				user(id: $id) {
					id
					name
				}
			}
		`;

		const variables = { id: 123 };

		// When
		const response = await client.gql({
			key: ["user", variables.id],
			query,
			variables,
		});

		// Then
		expect(response).toEqual(responsePayload.data);
		expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
		expect(global.fetch as jest.Mock).toHaveBeenCalledWith(clientConfig.graphUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				Authorization: `Bearer ${clientConfig.authToken}`,
			},
			body: JSON.stringify({ query, variables }),
		});
	});

	it("should throw an error if the network response is not ok", async () => {
		// Given
		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({ errors: [{ message: "Server error" }] }),
		});

		const clientConfig = {
			graphUrl: "https://test.com/graphql",
			authToken: "JWT123",
		};

		const client = new Client(clientConfig);

		const query = /* GraphQL */ `
			query GetUser($id: Int!) {
				user(id: $id) {
					id
					name
				}
			}
		`;

		const variables = { id: 123 };

		// When
		// Then
		await expect(client.gql({ key: ["user", 123], query, variables })).rejects.toThrowErrorMatchingInlineSnapshot(
			`"Network response was not ok. Status: 500, Internal Server Error"`,
		);

		expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
	});

	it("should throw an error if there are GraphQL errors in the response", async () => {
		// Given
		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: null,
				errors: [{ message: "Error 1" }, { message: "Error 2" }],
			}),
		});

		const clientConfig = {
			graphUrl: "https://test.com/graphql",
			authToken: "JWT123",
		};

		const client = new Client(clientConfig);

		const query = /* GraphQL */ `
			query GetUser($id: Int!) {
				user(id: $id) {
					id
					name
				}
			}
		`;

		const variables = { id: 123 };

		// When
		// Then
		await expect(client.gql({ key: ["user", 123], query, variables })).rejects.toThrowErrorMatchingInlineSnapshot(
			`"GraphQL Errors: [{"message":"Error 1"},{"message":"Error 2"}]"`,
		);
		expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
	});

	it("should throw an error if there is no data in the GraphQL response", async () => {
		// Given
		(global.fetch as jest.Mock).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: null }),
		});

		const clientConfig = {
			graphUrl: "https://test.com/graphql",
			authToken: "JWT123",
		};

		const client = new Client(clientConfig);

		const query = /* GraphQL */ `
			query GetUser($id: Int!) {
				user(id: $id) {
					id
					name
				}
			}
		`;

		const variables = {
			id: 123,
		};

		// When
		// Then
		await expect(client.gql({ key: ["user", 123], query, variables })).rejects.toThrowErrorMatchingInlineSnapshot(
			`"No data found in the GraphQL response."`,
		);
		expect(global.fetch as jest.Mock).toHaveBeenCalledTimes(1);
	});
});
