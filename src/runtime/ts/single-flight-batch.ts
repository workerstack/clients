import type { CallInput, ServiceEntry, ServiceMap, ServiceMapNode } from "./sdk.ts"
import { BATCH_VERSION, WRITE_METHODS } from "./sdk-single-flight.constants.ts"
import { READ_METHOD } from "./single-flight.constants.ts"

/** A JSON value, as a parsed body holds it. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject

/** A JSON object, as a parsed body holds it. */
export type JsonObject = { readonly [key: string]: Json }

/** One operation of the service map: its entry, and the member path the SDK calls it by. */
export type FlightOp = { entry: ServiceEntry; path: readonly string[] }

/** One read a batch asks for: the caller's name for it, its operation and its input. */
export type FlightRead = { id: string; input: CallInput; op: FlightOp }

/** A batch the service map allows: the write and its input, then the reads. */
export type FlightBatch = { input: CallInput; reads: readonly FlightRead[]; write: FlightOp }

/** What `parseBatch` answers: the batch, or why it was refused. */
export type ParsedBatch = { batch: FlightBatch } | { refused: string }

/** The input keys a write may carry; a read carries only params and search. */
type InputKey = "idempotencyKey" | "json" | "params" | "search"
const WRITE_KEYS: readonly InputKey[] = ["idempotencyKey", "json", "params", "search"]
const READ_KEYS: readonly InputKey[] = ["params", "search"]

/** Whether `node` is an operation, not a namespace of them. */
function isEntry(node: ServiceMapNode): node is ServiceEntry {
	return Object.hasOwn(node, "method") && typeof node["method"] === "string"
}

/** Every operation of `map` by its operationId. */
export function operationsOf(map: ServiceMap): ReadonlyMap<string, FlightOp> {
	const out = new Map<string, FlightOp>()
	function walk(node: ServiceMapNode, path: readonly string[]): void {
		if (isEntry(node)) out.set(node.id, { entry: node, path })
		else for (const [key, child] of Object.entries(node)) walk(child, [...path, key])
	}
	walk(map, [])
	return out
}

/** Whether `value` is a JSON object, not an array or null. */
function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether `value` is a string. */
function isString(value: Json | undefined): value is string {
	return typeof value === "string"
}

/** Whether `value` is what a path param may be: a string, or a finite number. */
function isParam(value: Json): value is number | string {
	return isString(value) || (typeof value === "number" && Number.isFinite(value))
}

/** Whether `value` is a JSON scalar: no array or object. */
function isScalar(value: Json): value is boolean | null | number | string {
	return value === null || typeof value !== "object"
}

/** Whether `value` is a JSON array. */
function isList(value: Json): value is readonly Json[] {
	return Array.isArray(value)
}

/** Whether `value` is what a query param may be: a scalar, or a list of them. */
function isSearchValue(value: Json): boolean {
	return isList(value) ? value.every(isScalar) : isScalar(value)
}

/** Whether `entry` is a plain REST call: no event stream, socket or realtime adapter. */
function isRest(entry: ServiceEntry): boolean {
	return (
		entry.call === undefined &&
		[entry.sse, entry.ws, entry.realtime].every((flag) => flag === undefined || flag === false)
	)
}

/** Whether `key` is one of `keys`. */
function isInputKey(key: string, keys: readonly InputKey[]): key is InputKey {
	return keys.some((allowed) => allowed === key)
}

/** Refuse the batch: `parseBatch` turns this into its answer. */
function refuse(why: string): never {
	throw new RangeError(why)
}

/** `value`'s path params, each one `entry` declares and a string or a number. */
function paramsOf(entry: ServiceEntry, value: Json): CallInput["params"] {
	if (!isObject(value)) return refuse("params is not an object")
	const declared = entry.params ?? []
	for (const [key, param] of Object.entries(value)) {
		if (!declared.includes(key)) refuse(`${entry.id} declares no param ${key}`)
		if (!isParam(param)) refuse(`param ${key} is not a string or a number`)
	}
	return value /* interpolatePath writes a number as its digits, as a generated number param */ as CallInput["params"]
}

/** One input key's field put on `input`, once it is what `entry` takes there. */
type Field = (input: CallInput, field: Json, entry: ServiceEntry) => void

function setIdempotencyKey(input: CallInput, field: Json, entry: ServiceEntry): void {
	if (!isString(field) || entry.idempotent !== true) refuse(`${entry.id} takes no idempotencyKey`)
	input.idempotencyKey = field
}

function setJson(input: CallInput, field: Json): void {
	input.json = field
}

function setParams(input: CallInput, field: Json, entry: ServiceEntry): void {
	input.params = paramsOf(entry, field)
}

function setSearch(input: CallInput, field: Json): void {
	if (!isObject(field) || !Object.values(field).every(isSearchValue)) refuse("search is not an object of scalars")
	input.search = field
}

const FIELDS = {
	idempotencyKey: setIdempotencyKey,
	json: setJson,
	params: setParams,
	search: setSearch,
} satisfies { readonly [K in InputKey]: Field }

/** `value` as the input `entry` is called with, holding only `keys`. */
function inputOf(entry: ServiceEntry, value: Json | undefined, keys: readonly InputKey[]): CallInput {
	if (value === undefined) return {}
	if (!isObject(value)) return refuse("input is not an object")
	const input: CallInput = {}
	for (const [key, field] of Object.entries(value)) {
		if (!isInputKey(key, keys)) refuse(`input key ${key} is not allowed here`)
		FIELDS[key](input, field, entry)
	}
	return input
}

/** The write `body` names: a REST operation sent with a write method. */
function writeOf(ops: ReadonlyMap<string, FlightOp>, body: JsonObject): FlightOp {
	const name = body["op"]
	const op = isString(name) ? ops.get(name) : undefined
	if (op === undefined || !WRITE_METHODS.includes(op.entry.method) || !isRest(op.entry)) refuse("op is no write")
	return op
}

/** A read's id: a non-empty string no other read of the batch has. */
function idOf(value: JsonObject, seen: Set<string>): string {
	const { id } = value
	if (!isString(id) || id === "" || seen.has(id)) refuse("a read has no id of its own")
	seen.add(id)
	return id
}

/** One read of a batch: a REST GET with a JSON answer, named by an id no other read has. */
function readOf(ops: ReadonlyMap<string, FlightOp>, value: Json, seen: Set<string>): FlightRead {
	if (!isObject(value)) return refuse("a read is not an object")
	const id = idOf(value, seen)
	const { operationId } = value
	const op = isString(operationId) ? ops.get(operationId) : undefined
	if (op === undefined || op.entry.method !== READ_METHOD || !isRest(op.entry)) refuse(`${id} is no read`)
	if (op.entry.accept !== undefined || op.entry.empty === true) refuse(`${id} answers no JSON`)
	return { id, input: inputOf(op.entry, value["input"], READ_KEYS), op }
}

/** `body` as a batch of `ops`: a version 1 batch of one write and at most `maxReads` reads, or why it is refused. */
export function parseBatch(ops: ReadonlyMap<string, FlightOp>, body: Json, maxReads: number): ParsedBatch {
	try {
		if (!isObject(body) || body["v"] !== BATCH_VERSION) return refuse("the body is no version 1 batch")
		const write = writeOf(ops, body)
		const input = inputOf(write.entry, body["input"], WRITE_KEYS)
		const reads = body["reads"] ?? []
		if (!isList(reads) || reads.length > maxReads) refuse(`reads is not a list of at most ${maxReads}`)
		const seen = new Set<string>()
		return { batch: { input, reads: reads.map((read) => readOf(ops, read, seen)), write } }
	} catch (e) {
		if (e instanceof RangeError) return { refused: e.message }
		throw e
	}
}
