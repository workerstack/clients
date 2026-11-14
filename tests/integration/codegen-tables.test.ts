/**
 * The tables gen restates because it never imports backend (H2), compared to backend's own: a drift is a red here,
 * not a wrong generated type later. backend is read through its published surface only: every key gen names is
 * answered by a real app (`ctx.res.json(key, …)`), and the status the app sends is the code gen pairs it with. A
 * status that carries no body (204, 205, 304) refuses the JSON answer, naming its code, and that code is the one read.
 */
import { honey, type StatusKey } from "@workerstack/backend/http"
import { testClient } from "@workerstack/backend/http/testing"
import { describe, expect, it } from "vitest"
import { STATUS_KEYS } from "../../src/emit/shared/status-keys.ts"

/** An app answering `GET /<key>` with that status key, the way a handler names a status. */
const app = honey()
app.get("/:key").handler((ctx) => {
	try {
		return ctx.res.json(ctx.params.key as StatusKey, {})
	} catch (error) {
		return ctx.res.json("ok", { refused: (error as Error).message })
	}
})
const client = testClient(app, { env: {} })

describe("gen's status keys", () => {
	it("are backend's status vocabulary, code for code", async () => {
		const answered: Record<number, string> = {}
		for (const key of Object.values(STATUS_KEYS)) {
			const res = await client.get(`/${key}`)
			const refused =
				res.status === 200 && key !== "ok" ? ((await res.json()) as { refused?: string }).refused : undefined
			const code =
				refused === undefined ? res.status : Number(/^A (\d{3}) response cannot have a body/.exec(refused)?.[1])
			answered[code] = key
		}
		expect(answered).toEqual(STATUS_KEYS)
	})
})
