/**
 * The TanStack Query adapter's cases' shared parts (tanstack-query.{behavior,infinite,invalidate}.test.ts): a service
 * map of reads, writes and streams; a fake SDK that records each call's one input and holds a `slow` read open until
 * its signal aborts; and each surface's leaf typed as the factory it is. The emitted leg is tanstack-query.emitted.ts.
 */
import { type QueryFunction, QueryClient, type QueryKey } from "@tanstack/query-core"

import type { Surface } from "../../../runtime/ts-tanstack-query/query.ts"
import type { ServiceMap } from "../../../runtime/ts/sdk.ts"

export const SDK_NAME = "acme"
export const ORG = "org_1"

// the shape serviceMapOf emits: `{p}` kept in `path`, `params` naming the path slots, flags only when set
export const serviceMap: ServiceMap = {
	auth: { listSecurityEvents: { id: "auth.listSecurityEvents", method: "GET", path: "/v1/auth/events" } },
	extract: {
		stream: { id: "extract.stream", method: "POST", path: "/v1/projects/extract-stream", sse: true },
		watch: { id: "extract.watch", method: "GET", path: "/v1/projects/watch", ws: true },
	},
	org: {
		create: { id: "org.create", method: "POST", path: "/v1/organizations" },
		get: { id: "org.get", method: "GET", params: ["organization_id"], path: "/v1/organizations/{organization_id}" },
		list: { id: "org.list", method: "GET", path: "/v1/organizations" },
		slow: { id: "org.slow", method: "GET", path: "/v1/organizations/slow" },
		update: {
			id: "org.update",
			method: "PATCH",
			params: ["organization_id"],
			path: "/v1/organizations/{organization_id}",
		},
	},
}

/** What a fake SDK method is called with: one input, the request and the SDK's own options in it. */
export type CallInput = {
	readonly json?: object
	readonly params?: object
	readonly search?: object
	readonly signal?: AbortSignal
	readonly timeout?: number
}

/** One call the fake SDK saw: its member path and its input. */
export type Recorded = { input: CallInput | undefined; member: string }

/** A fake SDK over `serviceMap` and the calls it saw; `slow` answers only by rejecting when its signal aborts. */
export function recordingSdk() {
	const calls: Recorded[] = []
	function answering(member: string) {
		return (input?: CallInput) => {
			calls.push({ input, member })
			return Promise.resolve({ member })
		}
	}
	function held(member: string) {
		return (input?: CallInput) => {
			calls.push({ input, member })
			return new Promise<never>((_, reject) => {
				input?.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
			})
		}
	}
	const sdk = {
		auth: { listSecurityEvents: answering("auth.listSecurityEvents") },
		extract: { stream: answering("extract.stream"), watch: answering("extract.watch") },
		org: {
			create: answering("org.create"),
			get: answering("org.get"),
			list: answering("org.list"),
			slow: held("org.slow"),
			update: answering("org.update"),
		},
	}
	return { calls, sdk }
}

/** A client that never retries, so a failing fetch fails once. */
export function testClient(): QueryClient {
	return new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })
}

/** The surface at `path` under `surface`, or a throw naming the path: a case reaches only what its map declares. */
function leaf(surface: Surface, path: readonly string[]): Surface {
	let node = surface
	for (const name of path) {
		const next = node[name]
		if (next === undefined) throw new Error(`no surface at ${path.join(".")}`)
		node = next
	}
	return node
}

/** What a fake or emitted SDK call answers. */
export type Answer = object

/** A read's options as a factory gives them: the call and the key, nothing else. */
export type ReadOptions<P = never> = { queryFn: QueryFunction<Answer, QueryKey, P>; queryKey: QueryKey }

/** A write's options as a factory gives them. */
export type WriteOptions = { mutationFn: (variables: CallInput) => Promise<Answer>; mutationKey: QueryKey }

/** `query.*`: the SDK's request and its own init, nothing of TanStack's. */
export type Read = (req?: CallInput, init?: CallInput) => ReadOptions

/** `infiniteQuery.*`: how a page param becomes the request, and the SDK's own init. */
export type Paged = <P>(build: (page: P) => CallInput | undefined, init?: CallInput) => ReadOptions<P>

/** The leaf of a `query` surface, typed as the factory a GET entry gives. */
export function readAt(surface: Surface, ...path: string[]): Read {
	return leaf(surface, path) as /* the runtime types surfaces loosely; a GET leaf is this factory */ Read
}

/** The leaf of an `infiniteQuery` surface. */
export function pagedAt(surface: Surface, ...path: string[]): Paged {
	return leaf(surface, path) as /* a GET leaf on `infiniteQuery` is this factory */ Paged
}

/** The leaf of a `mutation` surface. */
export function writeAt(surface: Surface, ...path: string[]): () => WriteOptions {
	return leaf(surface, path) as /* a write leaf on `mutation` is this factory */ () => WriteOptions
}

/** The leaf of a `queryKey` or `mutationKey` surface. */
export function keyAt(surface: Surface, ...path: string[]): (req?: CallInput) => QueryKey {
	return leaf(surface, path) as /* a key leaf builds the key its factory would use */ (req?: CallInput) => QueryKey
}

/** Which of `names` the node at `path` under `surface` offers. */
export function offered(surface: Surface, path: string, names: readonly string[]): boolean[] {
	const node = leaf(surface, [path])
	return names.map((name) => node[name] !== undefined)
}
