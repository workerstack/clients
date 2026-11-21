import type { ClientConfig, FreshReads, InvalidateEvent, InvalidateTarget } from "./config.ts"

/** One read a write makes stale, as the service map holds it: its operationId and its own path params. */
export type ServiceRead = { operationId: string; params: readonly string[] }

/** A value a target's param can hold: what a generated call takes for a path param. */
type ParamValue = InvalidateTarget["params"][string]

/** The path params a call was made with, as a generated call passes them: a param may be left undefined. */
type CallParams = Readonly<Record<string, ParamValue | undefined>>

/**
 * A successful call that may make reads stale: its operationId, `METHOD path` for the log, its reads and params, and
 * the reads a single-flight batch brought back with it.
 */
export type InvalidatingCall = {
	by: string
	/** the reads a single-flight batch brought back */
	fresh?: FreshReads | undefined
	operation: string
	params: CallParams | undefined
	reads: readonly ServiceRead[] | undefined
}

/** A param value a target can address a resource by: a number, a boolean, or a string that is a path segment. */
function isSegmentValue(value: ParamValue | undefined): value is ParamValue {
	if (typeof value === "number" || typeof value === "boolean") return true
	return typeof value === "string" && value !== "" && value !== "." && value !== ".."
}

/** Each read of `reads` with the write's raw `params` values for its own params; one it does not know is left out. */
export function targetsOf(reads: readonly ServiceRead[], params: CallParams | undefined): InvalidateTarget[] {
	return reads.map(({ operationId, params: names }) => {
		const known: InvalidateTarget["params"] = {}
		for (const name of names) {
			const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined
			if (isSegmentValue(value)) known[name] = value
		}
		return { operationId, params: known }
	})
}

/**
 * Call each `onInvalidate` hook of `config` in order, each after the last settles, with what `call` made stale;
 * none when it makes nothing stale. Never rejects: a hook's error, sync or async, goes to `onLog` as an `error` entry,
 * and with no `onLog`, or one that throws too, it is dropped, as a consumer callback's is on a realtime connection.
 */
export function runInvalidateHooks(config: ClientConfig, call: InvalidatingCall): Promise<void> {
	const hooks = config.onInvalidate ?? []
	const reads = call.reads ?? []
	if (reads.length === 0 || hooks.length === 0) return Promise.resolve()
	const event: InvalidateEvent = { by: call.by, targets: targetsOf(reads, call.params) }
	if (call.fresh !== undefined) event.fresh = call.fresh
	function failed(cause: unknown, durationMs: number): void {
		try {
			config.onLog?.({
				duration_ms: durationMs,
				error: cause,
				event: "error",
				level: "error",
				operation: call.operation,
			})
		} catch {
			/* an onLog that throws has nowhere left to report to: the write's result stands */
		}
	}
	let settled = Promise.resolve()
	for (const hook of hooks) settled = settled.then(() => runHook(hook, event, failed))
	return settled
}

/** One hook called with `event`, settled whether it returns, throws or rejects; its failure handed to `failed`. */
function runHook(
	hook: NonNullable<ClientConfig["onInvalidate"]>[number],
	event: InvalidateEvent,
	failed: (cause: unknown, durationMs: number) => void,
): Promise<void> {
	const start = Date.now()
	return new Promise<void>((resolve) => resolve(hook(event))).catch((cause: unknown) =>
		failed(cause, Date.now() - start),
	)
}
