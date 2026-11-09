/**
 * What every `.output()` route runs whatever the build: one value against its status's schema (the body and header
 * checks of output-check.ts call it), the check on a `forward()`ed answer, and the wrap that runs a check on what a
 * handler answers. Also the declaration's runtime shape: the shorthand recorded as its `application/json` form, and a
 * returned body answered at the sole 2xx status. The answer check itself is `#output-check` (output-check.ts).
 */
import { EK, HoneyError } from "../errors/error.ts"
import { isAnswer, type MaybePromise } from "../middleware/middleware.ts"
import { isForwarded } from "../response/builder.ts"
import { parseMediaType } from "../response/media-type.ts"
import type { HoneyRes } from "../response/response.ts"
import { codeToStatusKey, type StatusKey, statusKeyToCode } from "../response/status.ts"
import type { JsonShorthand, OutputSchemas, StatusSchemas } from "../routing/output-types.ts"
import type { StandardSchemaLike, StandardSchemaResult } from "./standard-schema.ts"

function failed(statusKey: string): HoneyError {
	return new HoneyError({ errorKey: EK.output_validation_failed, status: "internal_server_error", vars: { statusKey } })
}

function checked(result: StandardSchemaResult, statusKey: string): void {
	if (result.issues !== undefined) throw failed(statusKey)
}

/**
 * Check `data` against the schema for `statusKey`: nothing back when it passes, a promise only for
 * an async validator. A failure is a 500 `output_validation_failed` naming the status key; the
 * issues stay server-side.
 */
export function validateOutput(
	schema: StandardSchemaLike,
	statusKey: string,
	data: unknown,
): Promise<void> | undefined {
	const result = schema["~standard"].validate(data)
	if (result instanceof Promise) return result.then((r) => checked(r, statusKey))
	checked(result, statusKey)
	return undefined
}

/** A route's compiled check: the answer back as it was, or the failure. */
export type OutputCheck = (response: Response) => MaybePromise<Response>
/**
 * The check every route declaring `schemas` runs on what `forward()` answered, whatever the build: its
 * status must be a declared key, with its media type declared at that key unless it has no body, or one of
 * `errorStatuses`, the statuses of the error keys the route may throw, which passes as the upstream gave it. Its body
 * is never read. A refusal is the 500 an undeclared answer is: `output_validation_failed` naming the status, or
 * `output_content_type_mismatch`. Any other answer passes as it is.
 */
export function forwardCheck(schemas: OutputSchemas, errorStatuses: ReadonlySet<string>): OutputCheck {
	const types = new Map<string, Set<string>>()
	for (const [key, statuses] of Object.entries(schemas)) {
		if (key === "headers" || statuses === undefined) continue
		/* `redirect` names statuses with no body type */
		const essence = parseMediaType(key)?.essence
		for (const status of Object.keys(statuses as object)) {
			const declared = types.get(status) ?? new Set<string>()
			if (essence !== undefined) declared.add(essence)
			types.set(status, declared)
		}
	}
	return (response) => {
		if (!isForwarded(response)) return response
		const statusKey = codeToStatusKey[response.status] ?? String(response.status)
		const declared = types.get(statusKey)
		if (declared === undefined) {
			if (errorStatuses.has(statusKey)) return response
			throw failed(statusKey)
		}
		if (response.body === null) return response
		const essence = parseMediaType(response.headers.get("content-type"))?.essence
		if (essence === undefined || !declared.has(essence))
			throw new HoneyError({ errorKey: EK.output_content_type_mismatch, status: "internal_server_error" })
		return response
	}
}

/** `handler` with `check` on what it answers: synchronously when the handler and the check are. */
export function withOutput(
	check: OutputCheck,
	handler: (ctx: object) => MaybePromise<Response>,
): (ctx: object) => MaybePromise<Response> {
	/* a handler that answered nothing is the chain's to report: no check on what is not there */
	return (ctx) => {
		const answer = handler(ctx)
		if (answer instanceof Promise) return answer.then((response) => (response == null ? response : check(response)))
		return answer == null ? answer : check(answer)
	}
}

/**
 * The explicit form of `schemas`: a declaration naming a status at its top (the shorthand) holds the
 * `application/json` ones. One naming none stays as written, so a stray outer key is reported as one where the app is
 * documented; the types refuse a status key beside a media type.
 */
export function normalizeOutput(schemas: OutputSchemas | JsonShorthand): OutputSchemas {
	const { headers, redirect, ...rest } = schemas as JsonShorthand
	return Object.keys(rest).some((key) => Object.hasOwn(statusKeyToCode, key))
		? { "application/json": rest as StatusSchemas, headers, redirect }
		: (schemas as OutputSchemas)
}

/** The helper that answers a returned body of each media type; any other type is answered through `binary`. */
const BODY_HELPER: Readonly<Record<string, "csv" | "html" | "json" | "text" | "xml">> = {
	"application/json": "json",
	"application/xml": "xml",
	"text/csv": "csv",
	"text/html": "html",
	"text/plain": "text",
}

/**
 * `fn` answering what it returns through ctx.res when `out` declares one 2xx status under one media type: a value
 * that is no Response becomes that status's answer. An answer, or nothing, passes as it is. Which declarations allow a
 * body (not an event stream, not a status with headers) is the types' to refuse.
 */
export function answeringBody(
	out: OutputSchemas | null,
	fn: (ctx: object) => MaybePromise<Response>,
): (ctx: object) => MaybePromise<Response> {
	if (out === null) return fn
	const types = Object.keys(out).filter((key) => key.includes("/"))
	const type = types[0] as `${string}/${string}`
	/* the vocabulary starts at 200: under 300 is a success */
	const success = Object.keys(out[type] ?? {}).filter((key) => statusKeyToCode[key as StatusKey] < 300)
	if (types.length !== 1 || success.length !== 1) return fn
	const key = success[0] as StatusKey
	const helper = BODY_HELPER[type]
	const answer = (ctx: object, value: unknown): unknown => {
		if (value === undefined || isAnswer(value)) return value
		const res = (ctx as { readonly res: HoneyRes }).res
		return helper === undefined
			? res.binary(key, value as never, { contentType: type })
			: res[helper](key, value as never)
	}
	return (ctx) => {
		const result: unknown = fn(ctx)
		return (result instanceof Promise ? result.then((value) => answer(ctx, value)) : answer(ctx, result)) as never
	}
}
