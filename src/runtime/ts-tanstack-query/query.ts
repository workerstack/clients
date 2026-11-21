/**
 * The TanStack Query adapter a TS SDK vendors (bit 22), emitted beside it as
 * `<stem>.tanstack-query.gen.ts` under `--ts-tanstack-query`. Read as text by `emit/ts/tanstack-query.ts`
 * and never imported by the generator, like every other `runtime/` module; its `../ts/*.ts` imports are
 * rewritten to the emitted runtime on the way out, so this file type-checks here and resolves there.
 *
 * Three surfaces over the service map, which is the authority for every question: `query` for the `GET`
 * entries, `mutation` for the rest, and `infiniteQuery` for a paged read. An entry that is an event stream,
 * a websocket or a realtime connection belongs to neither — a stream is not a cache entry — and asking for
 * one gives `undefined` rather than a factory that would key a stream as data.
 *
 * Each factory returns only what it owns — the key and the function — and the caller spreads it into
 * TanStack's own options, so every other option is TanStack's, typed by TanStack. A write invalidates
 * nothing here: the SDK's `onInvalidate` hook (`invalidate.ts`) does, so a raw SDK call refreshes the
 * cache too. `@tanstack/query-core` is imported for types only: an emitted SDK is loaded from the
 * consumer's own tree, so a value import would have to resolve at run time.
 */
import type {
	DataTag,
	DefaultError,
	InfiniteData,
	InfiniteQueryObserverOptions,
	QueryFunction,
	QueryKey,
} from "@tanstack/query-core"
import type { ServiceEntry, ServiceMap } from "../ts/sdk.ts"
import { childOf, INFINITE, isEntry, isStream, READ, readKey } from "./invalidate.ts"

/* an SDK method, whatever its shape: `unknown` collapses call signatures, which is what this must not do */
type AnyMethod = (...args: any[]) => any

/** The per-call options a generated method's input carries beside the request; none of them is in a key. */
type CallOption = "baseURL" | "cookies" | "headers" | "idempotencyKey" | "raw" | "signal" | "timeout"

/** A method's one input, as its value overload (the last, which `infer` reads) takes it. */
type Input<M> = M extends AnyMethod ? Parameters<M>[0] : never
type Req<M> = Omit<NonNullable<Input<M>>, CallOption>
type Init<M> = Pick<NonNullable<Input<M>>, Extract<keyof NonNullable<Input<M>>, Exclude<CallOption, "raw">>>
type Data<M> = M extends (...args: never[]) => infer R ? Awaited<R> : never

/** `req` may be left out only when the request itself has no required field. */
type ReqArgs<M> = {} extends Req<M> ? [req?: Req<M>] : [req: Req<M>]
type ReadKey<T> = DataTag<QueryKey, T, DefaultError>

/** A read's key and function; `init` (a timeout, headers, a signal) reaches the call but not the key. */
export type QueryFactory<M> = (...args: [...ReqArgs<M>, init?: Init<M>]) => {
	queryFn: QueryFunction<Data<M>, QueryKey>
	queryKey: ReadKey<Data<M>>
}

/** A write's key and function; `mutate` takes the SDK method's own input, so a call site reads like the call. */
export type MutationFactory<M> = () => {
	mutationFn: (variables: Input<M>) => Promise<Data<M>>
	mutationKey: QueryKey
}

/**
 * A paged read: `build` turns a page param into the request. It is called once with `undefined` when the
 * options are made, for the key, so it must accept `undefined`; every page after shares that key.
 * `initialPageParam` and `getNextPageParam` are TanStack's, spread beside the result. The return names
 * TanStack's whole options type, not just the two fields it holds: that is what carries `P` to the
 * observer, which would otherwise infer the page param from `initialPageParam` alone.
 */
export type InfiniteFactory<M> = <P>(
	build: (pageParam: P) => Req<M>,
	init?: Init<M>,
) => Omit<
	InfiniteQueryObserverOptions<Data<M>, DefaultError, InfiniteData<Data<M>, P>, QueryKey, P>,
	"getNextPageParam" | "initialPageParam"
> & { queryKey: ReadKey<InfiniteData<Data<M>, P>> }

/** A read's key: the request in, the key `query` would use out, tagged so a cache read infers the answer. */
export type QueryKeyFactory<M> = (...args: ReqArgs<M>) => ReadKey<Data<M>>

/** A write's key, which is its member path. */
export type MutationKeyFactory = () => QueryKey

/**
 * One surface as this file can describe it: a tree of factories, indexable by name, callable at a leaf.
 * It cannot be more precise here — the map arrives as `ServiceMap`, whose literal types are gone — so the
 * emitted `<stem>.tanstack-query.gen.ts` declares the exact nested types and this shape disappears behind them.
 */
export interface Surface {
	(...args: any[]): any
	readonly [key: string]: Surface
}

type Kind = "infiniteQuery" | "mutation" | "query" | "queryKey" | "mutationKey"

/** The five surfaces, untyped here; the emitted wrapper types each from its document. */
export type QueryHelpers = Readonly<{ [K in Kind]: Surface }>

/** The member path's method on the SDK, read when the call is made so `getSdk` stays per-call. */
function methodAt(ctx: Context, member: readonly string[]): AnyMethod {
	let node: unknown = ctx.getSdk()
	for (const key of member) node = (node /* a path the map named: each step holds the next */ as Surface)[key]
	return node /* the leaf the map names an operation is its method */ as AnyMethod
}

/** Which surface an entry belongs to; a stream belongs to none. */
function surfaceOf(entry: ServiceEntry, surface: Kind): boolean {
	if (isStream(entry)) return false
	const read = entry.method === READ
	return surface === "mutation" || surface === "mutationKey" ? !read : read
}

type Context = { getSdk: () => unknown; sdkName: string }
type CallInit = { signal?: AbortSignal | undefined }

/** One signal for a call, and the release of the listeners that make it. */
type Linked = { done: () => void; signal: AbortSignal }

function noop(): void {}

/**
 * TanStack's signal and the caller's as one, by listeners: never `AbortSignal.any`, whose combined signal,
 * only weakly held, can be collected before it fires. TanStack's aborts on a cancel and when the last
 * observer leaves; `done` drops the listeners once the call settles.
 */
function linked(query: AbortSignal, own: AbortSignal | undefined): Linked {
	if (own === undefined) return { done: noop, signal: query }
	const sources = [query, own]
	const controller = new AbortController()
	const fired = sources.find((signal) => signal.aborted)
	if (fired !== undefined) controller.abort(fired.reason)
	function abort(event: Event): void {
		controller.abort((event.target /* a listener's target is its signal */ as AbortSignal).reason)
	}
	for (const signal of sources) signal.addEventListener("abort", abort, { once: true })
	function done(): void {
		for (const signal of sources) signal.removeEventListener("abort", abort)
	}
	return { done, signal: controller.signal }
}

/** One call of the member's method with `req` and `init`, under the query's signal and the caller's. */
async function call(
	ctx: Context,
	member: readonly string[],
	input: { init: CallInit | undefined; req: unknown; signal: AbortSignal },
) {
	const { done, signal } = linked(input.signal, input.init?.signal)
	try {
		const req = input.req /* a request is an object or nothing: the factories' types admit no other */ as object
		return await methodAt(ctx, member)({ ...req, ...input.init, signal })
	} finally {
		done()
	}
}

function queryOptionsAt(ctx: Context, member: string[]) {
	return (req?: unknown, init?: CallInit) => ({
		queryFn: (context: { signal: AbortSignal }) => call(ctx, member, { init, req, signal: context.signal }),
		queryKey: readKey(ctx.sdkName, member, req),
	})
}

function mutationOptionsAt(ctx: Context, member: string[]) {
	return () => ({
		mutationFn: (variables: unknown) => methodAt(ctx, member)(variables),
		mutationKey: [ctx.sdkName, ...member],
	})
}

function infiniteOptionsAt(ctx: Context, member: string[]) {
	return (build: (pageParam: unknown) => unknown, init?: CallInit) => ({
		queryFn: (context: { pageParam: unknown; signal: AbortSignal }) =>
			call(ctx, member, { init, req: build(context.pageParam), signal: context.signal }),
		queryKey: [...readKey(ctx.sdkName, member, build(undefined)), INFINITE],
	})
}

function queryKeyAt(ctx: Context, member: string[]) {
	return (req?: unknown) => readKey(ctx.sdkName, member, req)
}

function factoryFor(ctx: Context, surface: Kind, member: string[]) {
	if (surface === "query") return queryOptionsAt(ctx, member)
	if (surface === "mutation") return mutationOptionsAt(ctx, member)
	if (surface === "infiniteQuery") return infiniteOptionsAt(ctx, member)
	if (surface === "mutationKey") return () => [ctx.sdkName, ...member]
	return queryKeyAt(ctx, member)
}

/**
 * One surface as a proxy over the map: a branch gives a branch, an operation of that surface gives its
 * factory, and anything else — a write on `query`, a read on `mutation`, a stream on either, a name the
 * map does not hold — gives `undefined`, so the surface never invents an operation.
 */
function surfaceProxy(ctx: Context, surface: Kind, node: { map: ServiceMap; member: string[] }): Surface {
	return new Proxy(Object.create(null) /* a bare target: the proxy answers every read itself */ as Surface, {
		get(_, key) {
			if (typeof key !== "string") return undefined
			const child = childOf(node.map, key)
			if (child === undefined) return undefined
			const member = [...node.member, key]
			const map = child /* a child that is not an entry is a branch of the map */ as ServiceMap
			if (!isEntry(child)) return surfaceProxy(ctx, surface, { map, member })
			return surfaceOf(child, surface) ? factoryFor(ctx, surface, member) : undefined
		},
		has(_, key) {
			return typeof key === "string" && childOf(node.map, key) !== undefined
		},
	})
}

/**
 * The helper set over `map` for the SDK `getSdk` returns, read on every call so an isomorphic app can
 * hand each request its own client. `sdkName` heads every key, so two SDKs in one cache never collide.
 * The emitted wrapper passes its own map and name and types each surface from the document.
 */
export function queryHelpers(getSdk: () => unknown, map: ServiceMap, sdkName: string): QueryHelpers {
	const ctx: Context = { getSdk, sdkName }
	const root = { map, member: [] }
	return {
		infiniteQuery: surfaceProxy(ctx, "infiniteQuery", root),
		mutation: surfaceProxy(ctx, "mutation", root),
		mutationKey: surfaceProxy(ctx, "mutationKey", root),
		query: surfaceProxy(ctx, "query", root),
		queryKey: surfaceProxy(ctx, "queryKey", root),
	}
}
