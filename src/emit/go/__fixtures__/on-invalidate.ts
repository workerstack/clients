/**
 * The Go `OnInvalidate` cases' SDK (http.on-invalidate.test.ts, http.on-invalidate.hooks.test.ts): plan 2's document
 * in Go's terms, a write of each selector kind, an event stream and a socket that invalidate, a GET that does too, and
 * a write whose member is renamed (`safe` is `Safe_`, beside `Client.Safe()`); a consumer program's helpers that note
 * each event a client's hooks see and each OnLog entry that carries a hook's error.
 */
import { generateGoSdk } from "../sdk.ts"
import type { Consumer, Run } from "./consumer.ts"

export const MODULE = "example.com/invalidate"

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } }
const BODY = { content: { "application/json": { schema: { type: "object" } } } }

/** A required path parameter of `type`. */
function param(name: string, type = "string") {
	return { in: "path", name, required: true, schema: { type } }
}

/** A required path parameter that spans segments (`x-backend-wildcard`). */
function wildcardParam(name: string) {
	return { ...param(name), "x-backend-wildcard": true }
}

/** A read `operationId` over the path params `params`. */
function read(operationId: string, params: object[] = []) {
	return { operationId, parameters: params, responses: OK }
}

/** A write `operationId` with a JSON body over the path params `params`, invalidating `targets`. */
function write(operationId: string, params: object[], targets: string[]) {
	return { operationId, parameters: params, requestBody: BODY, responses: OK, "x-invalidate": targets }
}

const DOCUMENT = {
	components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } },
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/docs": { get: read("docs.list") },
		"/docs/{id}": { get: read("docs.get", [param("id")]) },
		"/feed": { get: read("feed.get") },
		"/feed/live": { get: { operationId: "feed.live", responses: SSE, "x-invalidate": ["GET /feed"] } },
		"/feed/refresh": { get: { ...read("feed.refresh"), "x-invalidate": ["GET /feed"] } },
		"/files/{rest}": { get: read("files.get", [wildcardParam("rest")]) },
		"/items/{id}": { get: read("items.get", [param("id")]) },
		"/orgs/{org}": { put: write("orgs.update", [param("org")], ["GET /orgs/:org/members/:id"]) },
		"/orgs/{org}/members/{id}": { get: read("members.get", [param("org"), param("id")]) },
		"/rooms/{room}/live": {
			get: {
				operationId: "rooms.live",
				parameters: [param("room")],
				responses: {},
				"x-invalidate": ["GET /rooms/:room/messages"],
				"x-websocket": true,
			},
		},
		"/rooms/{room}/messages": { get: read("rooms.messages", [param("room")]) },
		"/safe/{id}/files/{rest}": {
			put: write(
				"safe.save",
				[param("id"), wildcardParam("rest")],
				["GET /items/:id", "GET /files/*rest", "GET /docs/:id?"],
			),
		},
		"/users": { get: read("users.list"), post: write("users.create", [], ["GET /users"]) },
		"/users/{id}": {
			get: read("users.get", [param("id", "integer")]),
			patch: write("users.update", [param("id", "integer")], ["GET /users/:id"]),
		},
		"/users/{id}/avatar": {
			put: {
				...write("users.avatar", [param("id", "integer")], ["GET /users/:id"]),
				responses: { 204: { description: "saved" } },
			},
		},
	},
	security: [{ bearer: [] }],
}

/**
 * The program's helpers: `boom`, the error a failing hook returns; `shown`, an event as one note (`by`, then each
 * target's operationId and params, `|` between); `recorded`, a client over the recording transport (or `cfg`'s own)
 * whose OnInvalidate runs `hooks` then notes `invalidated <event>`, and whose OnLog notes `log <level> <event>` for an
 * entry carrying boom; `gate`, a transport answering `Bearer fresh` 200 `{}` and anything else 401, noting each token.
 */
const DECLS = `var boom = errors.New("boom")

type hook = func(context.Context, sdk.InvalidateEvent) error

func shown(e sdk.InvalidateEvent) string {
	parts := []string{e.By}
	for _, t := range e.Targets {
		parts = append(parts, t.OperationID+" "+fmt.Sprint(t.Params))
	}
	return strings.Join(parts, " | ")
}

func recorded(cfg sdk.Config, hooks ...hook) *sdk.Client {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "http://api.test"
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = transport
	}
	cfg.OnInvalidate = append(hooks, func(_ context.Context, e sdk.InvalidateEvent) error {
		note("invalidated", shown(e))
		return nil
	})
	cfg.OnLog = func(entry sdk.LogEntry) {
		if errors.Is(entry.Err, boom) {
			note("log", entry.Level, entry.Event)
		}
	}
	return sdk.NewClient(cfg)
}

type gate struct{}

func (gate) RoundTrip(req *http.Request) (*http.Response, error) {
	token := req.Header.Get("Authorization")
	note("sent", token)
	status, body := 401, \`{"message":"expired"}\`
	if token == "Bearer fresh" {
		status, body = 200, "{}"
	}
	return &http.Response{
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{"Content-Type": {"application/json"}},
		Request:    req,
		StatusCode: status,
	}, nil
}`

/** The SDK's files for DOCUMENT, generated once. */
let files: Readonly<Record<string, string>> | undefined

/**
 * What `consume` takes to run `body` beside the SDK, DECLS and `decls` declared, `errors` imported with `imports`. It
 * builds the arguments and spawns nothing, so the cases call `consume` (a listed spawning helper) themselves.
 */
export function invalidating(
	body: string,
	program: Omit<Consumer, "body"> = {},
): [Readonly<Record<string, string>>, string, Consumer] {
	files ??= generateGoSdk(DOCUMENT, { modulePath: MODULE }).files
	return [
		files,
		MODULE,
		{
			...program,
			body,
			decls: `${DECLS}\n${program.decls ?? ""}`,
			imports: ["errors", ...(program.imports ?? [])],
		},
	]
}

/** A note the recording transport wrote for a request: `METHOD url[ body]`. */
function isRequest(line: string): boolean {
	return /^[A-Z]+ https?:\/\//.test(line)
}

/** What a case reads of `run`: whether it built and vetted clean, and the notes of `section` less the request lines. */
export function noted(run: Run, section: string) {
	return { built: run.built, out: run.out?.[section]?.filter((line) => !isRequest(line)), vet: run.vet }
}

/** How many requests the recording transport saw in `section`. */
export function sent(run: Run, section: string): number {
	return run.out?.[section]?.filter(isRequest).length ?? 0
}

/** A built, vet-clean run's notes of a section: `out`. */
export function clean(out: readonly string[]) {
	return { built: true, out, vet: [] }
}

/** The note `users.update` with id 42 makes: its one target, `users.get` with the id as the call took it. */
export const UPDATED = "invalidated users.update | users.get map[id:42]"

/** The note `users.create` makes: the control write a case runs after the call it checks. */
export const CREATED = "invalidated users.create | users.list map[]"
