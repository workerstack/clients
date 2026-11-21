/** The only method and media type a batch is taken with. */
export const BATCH_METHOD = "POST"
export const BATCH_MEDIA_TYPE = "application/json"

/** The only `Sec-Fetch-Site` a browser may send a batch with. */
export const SAME_ORIGIN = "same-origin"

/** The method every read is sent with. */
export const READ_METHOD = "GET"

/** The problem `type` of a write that got no answer (a refusal's is the client's `REFUSED`). */
export const UNANSWERED = "urn:workerstack:single-flight:unanswered"

/** The statuses the handler answers with: the envelope, and a write that got no answer (a refusal's is the client's
    `REFUSED_STATUS`). */
export const ANSWERED_STATUS = 200
export const UNANSWERED_STATUS = 502

/** A read's own error statuses: no usable answer (no connection, over the byte budget, not JSON), and out of time. */
export const NO_ANSWER_STATUS = 502
export const TIMED_OUT_STATUS = 504

/** The success statuses: a write outside them runs no read. */
export const FIRST_SUCCESS = 200
export const LAST_SUCCESS = 299

/** The defaults: a batch body's bytes, and the reads' bytes in all and their time in milliseconds (the reads per
    batch: the client's `DEFAULT_MAX_READS`). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024
export const DEFAULT_READ_BUDGET_MS = 2000
