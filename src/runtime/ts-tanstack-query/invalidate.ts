/**
 * Turning a service map into query keys (bit 22): which entries are readable, what key a read is cached
 * under, and which keys a write's `onInvalidate` event makes stale. The event names reads by operationId
 * and a key names a member path, and this is the one place that crosses between them; `query.ts` holds
 * the surfaces that use it.
 */
import type { QueryClient, QueryKey } from "@tanstack/query-core"
import type { FreshReads, InvalidateEvent, InvalidateTarget, SingleFlightReadRequest } from "../ts/config.ts"
import type { ServiceEntry, ServiceMap } from "../ts/sdk.ts"

/** The one method a cache reads from; every other method is a write. */
export const READ = "GET"

export function isEntry(node: unknown): node is ServiceEntry {
	return (
		typeof node === "object" &&
		node !== null &&
		Object.hasOwn(node, "method") &&
		typeof (node /* narrowed to an own `method` just above */ as ServiceEntry).method === "string" &&
		Object.hasOwn(node, "path")
	)
}

/** A stream or a connection is not a cache entry, so it is in no surface. */
export function isStream(entry: ServiceEntry): boolean {
	return entry.sse !== undefined || entry.ws === true || entry.realtime === true
}

/** Only an own key is an operation: never `toString`, `constructor` or `then`. */
export function childOf(node: ServiceMap | ServiceEntry, key: string): ServiceMap | ServiceEntry | undefined {
	if (!Object.hasOwn(node, key)) return undefined
	return (node /* an own key of a map node is a branch or an entry */ as { readonly [key: string]: ServiceMap })[key]
}

/**
 * There are two kinds of key here and they are not the same job.
 *
 * `readKey` is an IDENTITY: the key one read is cached under. TanStack needs every input the `queryFn`
 * sends to be in it, so it holds the request object whole — `params`, `search`, and anything else the SDK
 * puts there. Only the request: `init` carries a signal and a timeout, which say nothing about the answer
 * and would not hash. Two reads of one route that differ by search are two entries, which is the whole
 * point.
 *
 * `targetKey` is a FILTER: the prefix an invalidation target makes stale. A write knows its own path
 * params and nothing about what a reader searched for, so it names `{ params }` at most and TanStack's
 * partial matching does the rest — `[sdk, …member, { params }]` matches a longer key that also carries
 * `search`, and `[sdk, …member]` matches every search there is.
 *
 * Collapsing the two is what shipped in 1.0.0-rc.8 with `search` missing from read keys.
 */
export function readKey(sdkName: string, member: readonly string[], req: unknown): QueryKey {
	const prefix = [sdkName, ...member]
	return req === undefined ? prefix : [...prefix, req]
}

/**
 * The marker that keeps a paged read off the plain read's entry: their cached shapes differ, one being
 * `InfiniteData`. It goes LAST so an invalidation filter still prefix-matches the paged key — a filter
 * compares only its own positions, so a shorter one reaches the longer key.
 */
export const INFINITE = "infinite"

/** The prefix a target makes stale: its member path, plus `{ params }` when the target names any. */
function targetKey(sdkName: string, member: readonly string[], params: InvalidateTarget["params"]): QueryKey {
	const prefix = [sdkName, ...member]
	return Object.keys(params).length === 0 ? prefix : [...prefix, { params }]
}

/** The request keys a single-flight read takes: a plain read's key holds no other. */
const FLIGHT_KEYS: readonly string[] = ["params", "search"]

/** Whether `value` is a request a single-flight read can carry: an object of params and search only. */
function isFlightRequest(value: unknown): value is SingleFlightReadRequest["input"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	return Object.keys(value).every((name) => FLIGHT_KEYS.includes(name))
}

/** The request a plain read's key at `member` holds, or undefined for any other key (a paged one, say). */
function requestOf(key: QueryKey, at: number): SingleFlightReadRequest["input"] | undefined {
	if (key.length === at) return {}
	const req = key[at]
	return key.length === at + 1 && isFlightRequest(req) ? req : undefined
}

/**
 * The single-flight `select` that brings back the active plain reads a write's targets match in `client`, each by
 * its query hash, so `invalidationHook` can seed it. A paged read, a disabled or unobserved one, and one whose
 * `meta.singleFlight` is false are left to refetch as before.
 */
export function activeReadsOf<Read extends string>(
	client: QueryClient,
	sdkName: string,
	members: ReadonlyMap<string, readonly string[]>,
): (targets: InvalidateTarget<Read>[]) => SingleFlightReadRequest<Read>[] {
	return (targets) => {
		const reads = new Map<string, SingleFlightReadRequest<Read>>()
		for (const { operationId, params } of targets) {
			const member = members.get(operationId)
			if (member === undefined) continue
			const filters = { queryKey: targetKey(sdkName, member, params), type: "active" as const }
			for (const query of client.getQueryCache().findAll(filters)) {
				const input = requestOf(query.queryKey, member.length + 1)
				if (input === undefined || query.meta?.["singleFlight"] === false) continue
				if (!reads.has(query.queryHash)) reads.set(query.queryHash, { id: query.queryHash, input, operationId })
			}
		}
		return [...reads.values()]
	}
}

/** Put each fresh read in `client` by its hash, a refetch in flight cancelled first; the hashes it put. */
async function seed(client: QueryClient, fresh: FreshReads | undefined): Promise<Set<string>> {
	const seeded = new Set<string>()
	const cache = client.getQueryCache()
	const each = [...(fresh?.data ?? [])].map(async ([hash, data]) => {
		const query = cache.get(hash)
		if (query === undefined) return
		await client.cancelQueries({ exact: true, queryKey: query.queryKey })
		client.setQueryData(query.queryKey, data)
		seeded.add(hash)
	})
	await Promise.all(each)
	return seeded
}

/** The filters a target's `queryKey` invalidates by: every match but a query `seeded` just put fresh data in. */
function filtersOf(queryKey: QueryKey, seeded: ReadonlySet<string>) {
	if (seeded.size === 0) return { queryKey }
	return { predicate: (query: { queryHash: string }) => !seeded.has(query.queryHash), queryKey }
}

/**
 * The SDK `onInvalidate` hook that makes a write's targets stale in `client`: each target's key by its
 * member path (`members`, operationId to path, which the emitted file builds from the document), an
 * operationId it does not hold skipped. `cancelRefetch` restarts a refetch already running, so the read
 * sees the write. The SDK awaits the hook, so a write resolves once its active reads have refetched: a
 * failing refetch holds it through its retries but never rejects it (TanStack's `invalidateQueries`
 * swallows a refetch error), and an infinite query refetches every page it holds. A single-flight write's
 * fresh reads are put in the cache first and not refetched; a failed one, and every other match, are.
 */
export function invalidationHook(
	client: QueryClient,
	sdkName: string,
	members: ReadonlyMap<string, readonly string[]>,
): (event: InvalidateEvent) => Promise<void> {
	return async (event) => {
		const seeded = await seed(client, event.fresh)
		const keys: QueryKey[] = []
		for (const target of event.targets) {
			const member = members.get(target.operationId)
			if (member !== undefined) keys.push(targetKey(sdkName, member, target.params))
		}
		const each = keys.map((key) => client.invalidateQueries(filtersOf(key, seeded), { cancelRefetch: true }))
		await Promise.all(each)
	}
}
