/**
 * The `.output()` type algebra: what a route declares it answers (a media type's bodies by 2xx status
 * key, its 3xx statuses, the headers of each 2xx or 3xx), each key it cannot answer refused with a message, and
 * ctx.res narrowed to it. A declared helper
 * takes only the declared status keys, each body typed by its status's schema and its options
 * carrying the status's declared headers; an undeclared one is gone, and so is raw; stream stays;
 * noContent only where a media type (or the shorthand) declares `no_content`; redirect takes only the
 * declared redirect keys; sse only for an event stream; binary for octet-stream or an open type.
 * The handler's return is narrowed the same way: a declared media type at one of its status keys, or the body
 * itself when the route declares one 2xx status under one media type. Status keys alone (`{ ok: schema }`) are the
 * shorthand for `{ "application/json": { ok: schema } }`.
 */
import type { BinaryBody } from "../response/binary.ts"
import type { HoneyRes, ResponseOptions, StreamBody, TypedResponse } from "../response/response.ts"
import type { RedirectKey, StatusKey } from "../response/status.ts"
import type { InferInput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** The 2xx status keys: the answers a media type's body slot takes. */
type SuccessKey =
	| "accepted"
	| "already_reported"
	| "created"
	| "im_used"
	| "multi_status"
	| "no_content"
	| "non_authoritative_information"
	| "ok"
	| "partial_content"
	| "reset_content"

/** The 3xx status keys `redirect` takes: the redirects `ctx.res.redirect` answers, and a 304 a forwarded answer may be. */
type BodilessKey = RedirectKey | "not_modified"

/** The status keys `headers` takes: every 2xx and 3xx. */
type HeaderKey = SuccessKey | BodilessKey

/** The 4xx and 5xx status keys: error answers, which a route declares with `.errors()`. */
type ErrorKey = Exclude<StatusKey, HeaderKey>

/** The helper each media type is answered with. */
type HelperOf = {
	/** The `ctx.res` method that answers `application/json`. */
	"application/json": "json"
	/** The `ctx.res` method that answers `application/xml`. */
	"application/xml": "xml"
	/** The `ctx.res` method that answers `text/csv`. */
	"text/csv": "csv"
	/** The `ctx.res` method that answers `text/event-stream`. */
	"text/event-stream": "sse"
	/** The `ctx.res` method that answers `text/html`. */
	"text/html": "html"
	/** The `ctx.res` method that answers `text/plain`. */
	"text/plain": "text"
}

/** The media types an editor completes in `.output()`: each helper's, and octet-stream, which `binary` answers. */
type KnownMediaType = keyof HelperOf | "application/octet-stream"

/**
 * A media type key: a known one, or any other `type/subtype` (`image/png`, `application/vnd.x+json`). The `& {}` keeps
 * the pattern from absorbing the known literals, so they stay completions.
 */
type MediaTypeKey = KnownMediaType | (`${string}/${string}` & {})

/** A media type's declared bodies by 2xx status key: a schema, or `true` for a body with none. */
export type StatusSchemas = { readonly [K in SuccessKey]?: StandardSchemaLike | true }

/** The headers each 2xx or 3xx status carries, by status key: a schema over the headers by lowercased name. */
export type HeaderSchemas = { readonly [K in HeaderKey]?: StandardSchemaLike }

/** The 3xx statuses a route declares, for the generators: no body, no schema. */
export type RedirectStatuses = { readonly [K in BodilessKey]?: true }

/**
 * What `.output()` takes: each media type it answers with (`type/subtype`) and its 2xx bodies, the 3xx statuses
 * (`redirect`: its redirects and a 304), and the headers each 2xx or 3xx status carries (`headers`). An error answer is
 * declared with `.errors()`.
 */
export type OutputSchemas = {
	/** The 2xx status keys this media type answers with, each with a body schema or `true`. */
	readonly [M in MediaTypeKey]?: StatusSchemas
} & {
	/** The schema of the headers each 2xx or 3xx status carries, by status key; that status's helper then requires them. */ readonly headers?: HeaderSchemas
	/** 3xx statuses: the redirects `ctx.res.redirect` takes, each documented with a `Location`, and a 304 a forwarded answer may be. */ readonly redirect?: RedirectStatuses
}

/** `.output()`'s shorthand: JSON bodies by 2xx status key, beside the headers and redirects of the explicit form. */
export type JsonShorthand = StatusSchemas & {
	/** The schema of the headers each 2xx or 3xx status carries, by status key; that status's helper then requires them. */ readonly headers?: HeaderSchemas
	/** 3xx statuses: the redirects `ctx.res.redirect` takes, each documented with a `Location`, and a 304 a forwarded answer may be. */ readonly redirect?: RedirectStatuses
}

/** `.output()`'s constraint, any object: `KnownStatusKeys` checks the keys, so each refusal reads as a message. */
export type LooseOutput = {
	/** Any key, checked by `KnownStatusKeys`. */
	readonly [key: string]: unknown
}

/** The media types a declaration names. */
type MediaTypes<TOutput> = Extract<keyof TOutput, MediaTypeKey>

/** Whether `TOutput` is the shorthand: no media type, and a status key. */
type IsShorthand<TOutput> = [MediaTypes<TOutput>] extends [never]
	? [Extract<keyof TOutput, StatusKey>] extends [never]
		? false
		: true
	: false

/** The declaration `.output()` records: the shorthand as its `application/json` form, the explicit one as written. */
export type NormalizeOutput<TOutput> = [TOutput] extends [never]
	? never
	: IsShorthand<TOutput> extends true
		? {
				readonly [K in "application/json" | Extract<keyof TOutput, "headers" | "redirect">]: K extends keyof TOutput
					? TOutput[K]
					: { readonly [S in Exclude<keyof TOutput, "headers" | "redirect">]: TOutput[S] }
			}
		: TOutput

/** Why key `K` names no answer a body slot or `headers` takes: an error status, a redirect, or no status at all. */
type Refusal<K> = K extends ErrorKey
	? `${K} is an error status: declare it with .errors(), not .output()`
	: K extends BodilessKey
		? `${K} is a redirect: declare it under redirect`
		: `${K & (string | number)} is no status key`

/** A media type's statuses, each key that is no 2xx mapped to its refusal. */
type BodyKeys<S> = { [K in keyof S]: K extends SuccessKey ? S[K] : Refusal<K> }

/** `redirect`'s statuses, each key that is no 3xx mapped to its refusal. */
type RedirectKeys<S> = {
	[K in keyof S]: K extends BodilessKey
		? S[K]
		: K extends StatusKey
			? `${K} is no 3xx status`
			: `${K & (string | number)} is no status key`
}

/** `headers`' statuses, each key that is no 2xx or 3xx mapped to its refusal. */
type HeaderKeys<S> = { [K in keyof S]: K extends HeaderKey ? S[K] : Refusal<K> }

/**
 * `TOutput` with every key that names no answer the route can give mapped to a message saying why: a 4xx/5xx key
 * (declared with `.errors()`), a 3xx key in a body slot (declared under `redirect`), a non-3xx under `redirect`, a
 * non-2xx/3xx under `headers`, a status key beside a media type, and a key that names no status. As `.output()`'s
 * parameter it refuses each such key where it is written, its message in the error, and `TOutput` is inferred from it
 * alone (intersecting `TOutput` too would collapse `true & message` to `never`). These maps add no `readonly`: TS
 * infers through a `+readonly` map with the modifier stripped, so `TOutput` would lose the `const` declaration's.
 * `assertOutputKeys` (openapi/output-keys.ts) refuses the same keys where an app is documented.
 */
export type KnownStatusKeys<TOutput> = {
	[K in keyof TOutput]: K extends "redirect"
		? RedirectKeys<TOutput[K]>
		: K extends "headers"
			? HeaderKeys<TOutput[K]>
			: K extends MediaTypeKey
				? BodyKeys<TOutput[K]>
				: K extends SuccessKey
					? IsShorthand<TOutput> extends true
						? TOutput[K]
						: `${K} beside a media type: write JSON as "application/json": { ${K}: ... }`
					: Refusal<K>
}

/** The media types answered through `binary`: octet-stream and any type no other helper answers. */
type BinaryTypes<TOutput> = Exclude<MediaTypes<TOutput>, keyof HelperOf>

/** The helpers a declaration allows. */
export type AllowedResMethods<TOutput> =
	| { [CT in keyof HelperOf]: CT extends keyof TOutput ? HelperOf[CT] : never }[keyof HelperOf]
	| ([BinaryTypes<TOutput>] extends [never] ? never : "binary")

/**
 * The helpers a route that declares an output keeps; `raw` is gone, since a raw Response declares nothing, and
 * `noContent` comes back only with a declared 204.
 */
type UniversalRes = Pick<HoneyRes, "stream">

/** `"no_content"` when some media type the output names declares it (the shorthand is under `application/json`), else `never`. */
type NoContentOf<TOutput> = Extract<
	{ [CT in MediaTypes<TOutput>]: keyof TOutput[CT] }[MediaTypes<TOutput>],
	"no_content"
>

/** The status keys the output's `redirect` entry declares (its redirects and a 304), or `never`. */
type BodilessOf<TOutput> = TOutput extends { readonly redirect?: infer R }
	? Extract<keyof NonNullable<R>, StatusKey>
	: never

/** The redirect keys the output's `redirect` entry declares, or `never`. */
type RedirectsOf<TOutput> = Extract<BodilessOf<TOutput>, RedirectKey>

/**
 * The answers `.output()` declares as a `Response`: each media type at its status keys, and with no body the
 * declared 204 and `bodiless`; none of those, no bodiless answer.
 */
type DeclaredResponse<TOutput, TBodiless extends StatusKey> =
	| { [CT in MediaTypes<TOutput>]: TypedResponse<CT, Extract<keyof TOutput[CT], StatusKey>> }[MediaTypes<TOutput>]
	| BodilessResponse<NoContentOf<TOutput> | TBodiless>

/** The bodiless answer at `TKeys`, or `never` for none: a `TypedResponse` at no status still stands in a union. */
type BodilessResponse<TKeys extends StatusKey> = [TKeys] extends [never] ? never : TypedResponse<"none", TKeys>

/**
 * What a handler may return: any typed answer without `.output()`; with one, a declared media type at one of its
 * status keys, a bodiless answer (no content, a redirect, a forwarded 304), or the sole body.
 */
export type DeclaredAnswer<TOutput> = [TOutput] extends [never]
	? TypedResponse
	: DeclaredResponse<TOutput, BodilessOf<TOutput>> | SoleBody<TOutput>

/** A declared body's type: its schema's input, what output validation accepts; `unknown` without a schema. */
type BodyOf<S> = S extends StandardSchemaLike ? InferInput<S> : unknown

/** The 2xx keys of a null-body status: `noContent()` (or `forward()`) answers them, never a body helper. */
type NullBodyKey = "no_content" | "reset_content"

/** The status keys a body helper takes under `CT`: the declared ones, less the null-body ones. */
type BodyKeyOf<TOutput, CT extends keyof TOutput> = Exclude<keyof TOutput[CT] & StatusKey, NullBodyKey>

/** Whether `T` is exactly one member: not `never`, not a union. */
type IsOne<T, TAll = T> = [T] extends [never] ? false : T extends unknown ? ([TAll] extends [T] ? true : false) : never

/**
 * The body a handler may return for honey to answer: with one media type and one 2xx status under it, that status's
 * body as its helper takes it. Never for an event stream, a bodiless status, or a status that declares headers.
 */
type SoleBody<TOutput> = IsOne<MediaTypes<TOutput>> extends true ? SoleBodyAt<TOutput, MediaTypes<TOutput>> : never

/** `SoleBody` under media type `CT`. */
type SoleBodyAt<TOutput, CT extends keyof TOutput> =
	IsOne<Extract<keyof TOutput[CT], SuccessKey>> extends true
		? SoleBodyOf<TOutput, CT, Extract<keyof TOutput[CT], SuccessKey>>
		: never

/** `SoleBody` at status `K` of media type `CT`. */
type SoleBodyOf<TOutput, CT extends keyof TOutput, K extends keyof TOutput[CT]> = K extends NullBodyKey
	? never
	: [HeadersOf<TOutput, K>] extends [never]
		? CT extends "application/json"
			? BodyOf<TOutput[CT][K]>
			: CT extends "text/event-stream"
				? never
				: CT extends Exclude<keyof HelperOf, "application/json">
					? string | StreamBody
					: BinaryBody | StreamBody
		: never

/** The header schema status `K` declares, or `never`. */
type HeadersOf<TOutput, K> = TOutput extends { readonly headers?: infer H }
	? K extends keyof NonNullable<H>
		? Exclude<NonNullable<H>[K], undefined>
		: never
	: never

/** The headers status `K` must carry in its options: its declared ones, others beside them. */
type HeaderOpt<TOutput, K> = [HeadersOf<TOutput, K>] extends [never]
	? {}
	: {
			/** Headers for the response: the declared ones are required, others are allowed. */ headers: InferInput<
				HeadersOf<TOutput, K>
			> &
				Record<string, string>
		}

/** The options for status `K`: required when it declares headers, optional otherwise. */
type OptsFor<TOutput, K, TExtra = {}> = [HeadersOf<TOutput, K>] extends [never]
	? [opts?: ResponseOptions & TExtra]
	: [opts: ResponseOptions & TExtra & HeaderOpt<TOutput, K>]

/** `method` narrowed to `CT`'s declared status keys, the body typed (`json`) or text (the others). */
type Narrowed<TOutput, CT extends keyof HelperOf, TText extends boolean> = CT extends keyof TOutput
	? {
			[M in HelperOf[CT]]: <K extends BodyKeyOf<TOutput, CT>>(
				statusKey: K,
				body: TText extends true ? string | StreamBody : BodyOf<TOutput[CT][K]> | StreamBody,
				...opts: OptsFor<TOutput, K>
			) => TypedResponse<CT, K>
		}
	: {}

/** `binary` for a declared open type, its content type named; octet-stream may leave it out. */
type BinaryCall<TOutput> = (<CT extends BinaryTypes<TOutput>, K extends BodyKeyOf<TOutput, CT>>(
	statusKey: K,
	body: BinaryBody | StreamBody,
	opts: ResponseOptions &
		HeaderOpt<TOutput, K> & {
			/** The media type of the body, one the route declares; only `application/octet-stream` may be left out. */ contentType: CT
		},
) => TypedResponse<CT, K>) &
	("application/octet-stream" extends keyof TOutput
		? <K extends BodyKeyOf<TOutput, "application/octet-stream">>(
				statusKey: K,
				body: BinaryBody | StreamBody,
				...opts: OptsFor<
					TOutput,
					K,
					{
						/** The media type of the body; left out, it is `application/octet-stream`. */ contentType?: "application/octet-stream"
					}
				>
			) => TypedResponse<"application/octet-stream", K>
		: unknown)

/** ctx.res for a route declaring `TOutput`. */
type OutputRes<TOutput> = UniversalRes & {
	/**
	 * Answers `response` as it is, its status decided elsewhere (a stored file's 206 or 304); a status or media type
	 * the route does not declare is refused as an undeclared answer is. Its body is not validated.
	 */
	forward: (response: Response) => DeclaredResponse<TOutput, BodilessOf<TOutput>>
} & Narrowed<TOutput, "application/json", false> &
	Narrowed<TOutput, "text/plain", true> &
	Narrowed<TOutput, "text/html", true> &
	Narrowed<TOutput, "application/xml", true> &
	Narrowed<TOutput, "text/csv", true> &
	("text/event-stream" extends keyof TOutput ? Pick<HoneyRes, "sse"> : {}) &
	([NoContentOf<TOutput>] extends [never] ? {} : Pick<HoneyRes, "noContent">) &
	([RedirectsOf<TOutput>] extends [never]
		? {}
		: {
				/** A redirect to `url`, at one of the redirect keys the output declares. */ redirect: <
					SK extends RedirectsOf<TOutput>,
				>(
					statusKey: SK,
					url: string,
					opts?: ResponseOptions,
				) => TypedResponse<"none", SK>
			}) &
	([BinaryTypes<TOutput>] extends [never]
		? {}
		: {
				/** Answers with a binary body; available when the route declares a media type no other helper answers, such as `image/png`. */ binary: BinaryCall<TOutput>
			})

/** `TCtx` with ctx.res narrowed to `TOutput`; a route without `.output()` keeps the whole HoneyRes. */
export type ApplyOutput<TCtx, TOutput> = [TOutput] extends [never]
	? TCtx
	: Omit<TCtx, "res"> & {
			/** The context's `res`, narrowed to the route's declared output. */ readonly res: OutputRes<TOutput>
		}
