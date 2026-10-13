import type { GraphQLFormattedError } from "./types";

/**
 * Details attached to a {@link ClientError}.
 */
export interface ClientErrorDetails {
	/** HTTP status code of the response */
	status: number;
	/** GraphQL errors returned by the server, if any */
	errors?: ReadonlyArray<GraphQLFormattedError>;
	/** Partial data returned alongside the errors, if any */
	data?: unknown;
	/** The raw fetch Response */
	response: Response;
	/** Underlying error (e.g. a JSON parse failure) */
	cause?: unknown;
}

/**
 * Thrown when the server answers with a non-2xx status, GraphQL errors, an unparseable body or no data.
 * Transport failures (DNS, CORS, offline) and aborts are not wrapped and propagate as thrown by `fetch`.
 */
export class ClientError extends Error {
	/** HTTP status code of the response */
	readonly status: number;

	/** GraphQL errors returned by the server. Empty when the failure is not GraphQL-level. */
	readonly errors: ReadonlyArray<GraphQLFormattedError>;

	/** Partial data returned alongside the errors, if any */
	readonly data: unknown;

	/** The raw fetch Response */
	readonly response: Response;

	/**
	 * @param message - Human-readable summary
	 * @param details - Response details
	 */
	constructor(message: string, details: ClientErrorDetails) {
		super(message, { cause: details.cause });
		this.name = "ClientError";
		this.status = details.status;
		this.errors = details.errors ?? [];
		this.data = details.data;
		this.response = details.response;
	}
}

/**
 * Type guard for {@link ClientError}. Survives duplicated module instances, unlike `instanceof`.
 *
 * @param error - Any thrown value
 * @returns `true` when the value is a ClientError
 */
export function isClientError(error: unknown): error is ClientError {
	return error instanceof ClientError || (error instanceof Error && error.name === "ClientError");
}
