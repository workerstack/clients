/** The one batch version a single-flight handler reads. */
export const BATCH_VERSION = 1

/** The only method and media type a batch is taken with. */
export const BATCH_METHOD = "POST"
export const BATCH_MEDIA_TYPE = "application/json"

/** The only `Sec-Fetch-Site` a browser may send a batch with. */
export const SAME_ORIGIN = "same-origin"

/** The method every read is sent with, and the methods a write may be. */
export const READ_METHOD = "GET"
export const WRITE_METHODS: readonly string[] = ["DELETE", "PATCH", "POST", "PUT"]

/** The problem `type` of a refusal, and of a write that got no answer. */
export const REFUSED = "urn:workerstack:single-flight:refused"
export const UNANSWERED = "urn:workerstack:single-flight:unanswered"

/** The statuses the handler answers with: the envelope, a refusal, and a write that got no answer. */
export const ANSWERED_STATUS = 200
export const REFUSED_STATUS = 400
export const UNANSWERED_STATUS = 502

/** A read's own error statuses: no usable answer (no connection, over the byte budget, not JSON), and out of time. */
export const NO_ANSWER_STATUS = 502
export const TIMED_OUT_STATUS = 504

/** The success statuses: a write outside them runs no read. */
export const FIRST_SUCCESS = 200
export const LAST_SUCCESS = 299

/** The defaults: a batch body's bytes, the reads per batch, their bytes in all and their time in milliseconds. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_MAX_READS = 10
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024
export const DEFAULT_READ_BUDGET_MS = 2000
