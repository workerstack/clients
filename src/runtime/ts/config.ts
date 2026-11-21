import type { RequestOptions } from "./request.ts"

export type HeadersContext = {
	method: string
	path: string
}

type HeadersRecord = Record<string, string | undefined>

export type HeadersInit = ((ctx: HeadersContext) => HeadersRecord | Promise<HeadersRecord>) | HeadersRecord

/** What the SDK knows of a read's staleness, handed to the request and response hooks. */
export type RequestMeta = {
	invalidatedBy: string[]
	isStale: boolean
	selector: string
	seqSnapshot: number
}

export type OnRequestContext = {
	body?: BodyInit | undefined
	headers: Headers
	invalidatedBy?: string[] | undefined
	isStale?: boolean | undefined
	method: string
	/** the operation's path template, as the document spells it (`/items/{id}`), never the filled-in URL */
	path: string
	selector?: string | undefined
	state: Record<string, unknown>
	url: string
}

export type OnResponseContext = {
	invalidatedBy?: string[]
	isRetry: boolean
	isStale?: boolean
	method: string
	/** the operation's path template, as the document spells it (`/items/{id}`), never the filled-in URL */
	path: string
	readonly request: Request
	response: Response
	/**
	 * Send the request once more and resolve with the new response, whatever its status. On a
	 * request that is itself a retry, it resolves with the current response (one retry max).
	 */
	retry: () => Promise<Response>
	selector?: string
	state: Record<string, unknown>
	url: string
}

/**
 * - `same-origin` (default): follow redirects that stay on the base URL's origin; a cross-origin
 *   redirect is returned unfollowed (a non-2xx result). In browsers, which hide redirect targets
 *   from script, the platform follows and applies CORS to the target.
 * - `follow`: also follow cross-origin redirects. Such a hop carries only `Accept`,
 *   `Accept-Language` and `User-Agent` (no credentials, auth header, configured, per-call or
 *   `onRequest` header) and never replays a body.
 * - `manual` / `error`: passed to `fetch`.
 */
export type RedirectPolicy = "error" | "follow" | "manual" | "same-origin"

/**
 * One `onLog` entry: what happened to which operation and how long it took. `operation` is `METHOD` and the
 * path template, the same spelling a hook's `ctx.path` carries (`GET /items/{id}`).
 */
export type LogEntry = {
	duration_ms: number
	error?: unknown
	event: "error" | "hook_executed" | "request_start" | "response_received"
	level: "debug" | "error" | "info" | "warn"
	operation: string
	status?: number
}

/**
 * One read a write made stale: its operationId, and the write's values for the read's own path params it knows. A
 * generated SDK's config narrows `Read` to the reads its API invalidates.
 */
export type InvalidateTarget<Read extends string = string> = {
	operationId: Read
	params: Record<string, string | number | boolean>
}

/**
 * What a successful write made stale: `by` is the write's operationId, `targets` the reads it invalidates. A
 * generated SDK's config narrows `Write` and `Read` to its API's operationIds.
 */
export type InvalidateEvent<Write extends string = string, Read extends string = string> = {
	by: Write
	/** the reads a single-flight batch brought back with the write, by the id `select` gave each; unset otherwise */
	fresh?: FreshReads
	targets: InvalidateTarget<Read>[]
}

/** The reads a single-flight batch brought back: each answered read's data by its id, and the ids that failed. */
export type FreshReads = { data: Map<string, unknown>; failed: Set<string> }

/** One read a single-flight batch asks for: an id of the caller's, the read's operationId and its input. */
export type SingleFlightReadRequest<Read extends string = string> = {
	id: string
	input: { params?: InvalidateTarget["params"]; search?: RequestOptions["search"] }
	operationId: Read
}

/** The batch a single-flight write sends: the write's operationId and input, and the reads to bring back. */
export type SingleFlightBatch = {
	input: Pick<RequestOptions, "idempotencyKey" | "json" | "params" | "search">
	op: string
	reads: SingleFlightReadRequest[]
	v: 1
}

/**
 * Send each eligible write to a single-flight handler with the reads it makes stale, in one request, and hand the
 * reads it brings back to the `onInvalidate` hooks as `fresh`. A write is eligible when it is a REST JSON write with
 * `x-invalidate` reads, called with no headers, cookies, baseURL, body, form or raw, not in `exclude`, not
 * `singleFlight: false`, and `select` picks a read for it; every other call goes direct. A refusal resends the write
 * direct, with the same Idempotency-Key; any other failure of the batch throws, and nothing is resent.
 */
export type SingleFlightConfig<Write extends string = string, Read extends string = string> = {
	/** the writes that always go direct */
	exclude?: readonly Write[]
	/** the most reads one batch brings back; past it the rest are cut. Default 10, the handler's own default. */
	maxReads?: number
	/** the handler's path under `baseURL`. Default `"_mutate"`. */
	path?: string
	/** the reads to bring back of those the write made stale; none sends the write direct */
	select: (targets: InvalidateTarget<Read>[]) => SingleFlightReadRequest<Read>[]
	/** send the batch some other way (a server function): it resolves the handler's envelope, and throws on a refusal */
	send?: (batch: SingleFlightBatch) => Promise<object>
}

export type AuthExpiredContext = {
	/** The token the 401 rejected (read from the auth header), so concurrent 401s can share one refresh. */
	rejectedToken: string | null
}

export type ClientConfig = {
	/** The header for `onAuthExpired`'s token: unset, the API's scheme's; set, its prefix is yours (unset: none). */
	authHeaderName?: string
	/** That header's prefix; set alone, the scheme's header keeps it. */
	authHeaderPrefix?: string
	/** Absolute `http(s):` / `ws(s):` URL, or a same-origin path such as `"/api"`. */
	baseURL: string
	buildSearchParams?: (query: Record<string, unknown>) => URLSearchParams
	credentials?: RequestCredentials
	/** Defaults to the environment `fetch`, bound so it is safe to call in browsers. */
	fetch?: typeof fetch
	headers?: HeadersInit
	/** The most characters of a server's error message a ClientError carries. Default 512. */
	maxErrorMessageChars?: number
	/**
	 * The most bytes a response body may hold, decoded, before its read is refused with a ClientError and the body
	 * cancelled: it is read in the chunks it arrives in, never whole. Default 100 MiB. Streams are bounded by their
	 * own per-event caps instead.
	 */
	maxResponseBytes?: number
	mode?: RequestMode
	/**
	 * Called on a 401. Return a fresh token to retry the request once with it (and use it for later
	 * requests); return null or "" to give up. Concurrent 401s share one call. Requests whose body
	 * is a stream are not retried.
	 */
	onAuthExpired?: (ctx: AuthExpiredContext) => Promise<string | null | undefined> | string | null | undefined
	/**
	 * Called once per call, never once per attempt, after a write's final answer (an auth refresh or an `onResponse`
	 * retry included) is a 2xx, or a 2xx whose body does not decode, with the reads its `x-invalidate` makes stale. A
	 * write with no such reads calls none. `onResponse` runs once per attempt, so do not rebuild this there. Each hook
	 * runs in order and is awaited, and the write resolves after the last: a hook that never settles holds the write
	 * past `timeout`. A hook's error never changes the write's result; it goes to `onLog` as an `error` entry, and is
	 * dropped with no `onLog`. An event stream or WebSocket calls them once it opens, detached: nothing waits on them.
	 */
	onInvalidate?: Array<(event: InvalidateEvent) => Promise<void> | void>
	/** Called at each exchange's start, its answer and its failure (v0's entry shape). */
	onLog?: (entry: LogEntry) => void
	onReconnected?: () => void
	onReconnecting?: (attempt: number, transport: string) => void
	onRequest?: Array<(ctx: OnRequestContext) => Promise<void> | void>
	onResponse?: Array<(ctx: OnResponseContext) => Promise<Response | undefined> | Response | undefined>
	/** Redirect handling; see `RedirectPolicy`. Default `"same-origin"`. */
	redirect?: RedirectPolicy
	/** Send an `x-request-id` header on every request. Default `true`; `false` avoids a CORS preflight. */
	requestId?: boolean
	sortSearchParams?: boolean
	/** The most UTF-8 bytes one event-stream line may hold before the stream errors. Default 1 MiB. */
	sseMaxLineBytes?: number
	/** The most UTF-8 bytes one event's data may hold, its joining newlines counted. Default 8 MiB. */
	sseMaxEventBytes?: number
	state?: Record<string, unknown>
	/** Milliseconds for a whole request, including reading the body; a stream's only up to its headers. */
	timeout?: number
}
