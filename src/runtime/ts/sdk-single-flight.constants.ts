/** The one batch version a single-flight handler reads, and the client sends. */
export const BATCH_VERSION = 1

/** The methods a single-flight write may be. */
export const WRITE_METHODS: readonly string[] = ["DELETE", "PATCH", "POST", "PUT"]

/** The problem `type` and status a handler refuses a batch with: the client resends the write direct. */
export const REFUSED = "urn:workerstack:single-flight:refused"
export const REFUSED_STATUS = 400

/** The most reads one batch asks for, the client's and the handler's default. */
export const DEFAULT_MAX_READS = 10

/** The handler's path under the base URL when the config names none. */
export const DEFAULT_FLIGHT_PATH = "_mutate"

/** The status of a write's 401, which comes back inside the envelope. */
export const UNAUTHORIZED_STATUS = 401

/** The statuses a write's answer may have: a response's own range, past its informational ones. */
export const MIN_WRITE_STATUS = 200
export const MAX_WRITE_STATUS = 599

/** The statuses whose answer has no body. */
export const NO_BODY_STATUSES: readonly number[] = [204, 205, 304]
