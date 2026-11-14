/* What spawns a process, for clients/spawn-timeout: node:child_process's spawn, spawnSync, exec*, execFile* and fork,
 * Bun.spawn, Bun.spawnSync and Bun.$, a function of the same file that reaches one of them, and the repo helpers named
 * in SPAWNING_HELPERS, imported by name or through a namespace (called on it, or destructured from it). A rule sees one file, so that list carries what another module's helper does; spawners.test.ts
 * derives the set from the code and holds the list equal to it, so it cannot rot either way. */
import { dirname, join, normalize } from "node:path"

const CHILD_PROCESS = new Set(["node:child_process", "child_process"])
const PRIMITIVES = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"])
const BUN_SPAWN = new Set(["$", "spawn", "spawnSync"])

/* Exports whose spawn the code holds for later, with why: a call builds something and spawns nothing. Each must still
 * reach a spawn (spawners.test.ts), so a stale entry reds. */
export const DEFERRED = new Map([])

/** Repo path → the exports a test may call that spawn, each found by spawners.test.ts. */
export const SPAWNING_HELPERS = new Map([
	["lint/rule-harness.ts", ["oxlintReports"]],
	["scripts/sdk-budget.ts", ["listedEntries", "runtimeBytes"]],
	["src/cli.ts", ["generated", "main"]],
	["src/emit/cli/__fixtures__/built.ts", ["builtCli"]],
	["src/gen/formatters.ts", ["formatterFor"]],
	["src/release/__fixtures__/release-repo.ts", ["gitRepo"]],
	["src/release/bootstrap.ts", ["countRemoteCommits"]],
	["src/release/digest.ts", ["handDigest"]],
	["src/release/git.ts", ["getRemoteTip", "gitExitCode", "gitOutput", "gitRun"]],
	["src/release/load.ts", ["loadRelease", "readRelease"]],
	["src/release/oasdiff.ts", ["apiChanges"]],
	["src/release/sync-tree.ts", ["pendingTag", "replaceTreeWithSource"]],
	["src/release/sync.ts", ["syncAll"]],
	["src/emit/cli/__fixtures__/tools.ts", ["syntaxCheck", "withTools"]],
	["src/emit/cli/__fixtures__/yaml.ts", ["yamlValue"]],
	["src/emit/csharp/__fixtures__/compiled.ts", ["compiledCSharp"]],
	["src/emit/csharp/__fixtures__/consumer.ts", ["checked", "consume"]],
	["src/emit/csharp/__fixtures__/csharp-env.ts", ["execDotnet", "hasDotnet", "runCsc", "runDotnet", "withDotnet"]],
	["src/emit/csharp/__fixtures__/driven.ts", ["drivenCSharpSdk", "driverDll", "servedCSharpSdk"]],
	["src/emit/go/__fixtures__/compiled.ts", ["compileGo", "compiledSdk"]],
	["src/emit/go/__fixtures__/consumer.ts", ["check", "checkServed", "consume"]],
	["src/emit/go/__fixtures__/go-env.ts", ["gofmtPath", "hasGo", "runGo", "withGo"]],
	["src/emit/java/__fixtures__/compiled.ts", ["compiledJavaSdk"]],
	["src/emit/java/__fixtures__/driven.ts", ["drivenJavaSdk", "servedJavaSdk"]],
	["src/emit/java/__fixtures__/java-env.ts", ["runGjf", "runGradle", "runJava", "runJavac"]],
	["src/emit/java/__fixtures__/realtime-program.ts", ["runner"]],
	["src/emit/java/__fixtures__/realtime.ts", ["consumed", "drivenRealtime"]],
	["src/emit/mcp/__fixtures__/clients.ts", ["clientCheck", "clientSession", "hasNpm", "httpSession"]],
	["src/emit/mcp/__fixtures__/http-server.ts", ["serving"]],
	["src/emit/mcp/__fixtures__/python-client.ts", ["pythonHttpSession", "pythonOAuthSession", "pythonSession"]],
	["src/emit/mcp/__fixtures__/written.ts", ["exchange", "exchangeEach", "live", "typeErrors"]],
	["src/emit/python/__fixtures__/compiled.ts", ["compiledPython"]],
	["src/emit/python/__fixtures__/consumer.ts", ["checked", "consume"]],
	["src/emit/python/__fixtures__/driven.ts", ["drivenPythonSdk", "servedPythonSdk"]],
	[
		"src/emit/python/__fixtures__/python-env.ts",
		["hasPython", "resolve", "ruffPath", "runPython", "runRuff", "venv", "withPython"],
	],
	["src/emit/python/__fixtures__/ruff-gate.ts", ["formatted", "ruffGate", "ruffGates"]],
	["src/emit/rust/__fixtures__/compiled.ts", ["compiledRust"]],
	["src/emit/rust/__fixtures__/consumer.ts", ["consume"]],
	["src/emit/rust/__fixtures__/driven.ts", ["drivenRustSdk", "servedRustSdk"]],
	[
		"src/emit/rust/__fixtures__/rust-env.ts",
		["hasRust", "runCargo", "runRustc", "runRustfmt", "rustfmtPath", "withRust"],
	],
	["src/emit/shared/gofmt.ts", ["gofmtFormatter"]],
	["src/emit/shared/ruff.ts", ["ruffFormatter"]],
	["src/emit/shared/rustfmt.ts", ["rustfmtFormatter"]],
	["src/gen/__fixtures__/pinned-bun.ts", ["findPinnedBun", "withPinnedBun"]],
	["src/gen/process.ts", ["runCli"]],
	["tests/integration/conformance/harness.ts", ["startReferenceApp", "targetSuite"]],
	["tests/structure/mutation-harness.ts", ["runSuite"]],
])

export { repoPath } from "./repo-path.js"

/** The repo path an import `source` of the file at `from` names, its extension as written. */
function resolveImport(from, source) {
	return source.startsWith(".") ? normalize(join(dirname(from), source)).replaceAll("\\", "/") : undefined
}

/** The spawning names a file imports, and each namespace it imports mapped to the names on it that spawn. */
function importsOf(program, from, helpers) {
	const names = new Set()
	const namespaces = new Map()
	for (const statement of program.body) {
		if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
		const source = statement.source.value
		const listed = CHILD_PROCESS.has(source)
			? PRIMITIVES
			: new Set(helpers.get(resolveImport(from, source) ?? "") ?? [])
		for (const specifier of statement.specifiers) {
			if (specifier.type === "ImportNamespaceSpecifier") {
				if (listed.size > 0) namespaces.set(specifier.local.name, listed)
			} else if (
				specifier.type === "ImportSpecifier" &&
				listed.has(specifier.imported.name ?? specifier.imported.value)
			)
				names.add(specifier.local.name)
		}
	}
	return { names, namespaces }
}

/** The local names `declarator` (`const { a, b: c } = ns`) takes off a spawning namespace: `a` and `c` when they spawn. */
function takenFrom(declarator, namespaces) {
	const listed = declarator.init?.type === "Identifier" ? namespaces.get(declarator.init.name) : undefined
	if (listed === undefined || declarator.id.type !== "ObjectPattern") return []
	return declarator.id.properties.flatMap((property) =>
		property.type === "Property" &&
		!property.computed &&
		property.value.type === "Identifier" &&
		listed.has(property.key.name ?? property.key.value)
			? [property.value.name]
			: [],
	)
}

/** Every name the file's destructurings take off a spawning namespace, at any depth. */
function destructuredFrom(node, namespaces, out = new Set()) {
	if (typeof node !== "object" || node === null) return out
	if (Array.isArray(node)) {
		for (const child of node) destructuredFrom(child, namespaces, out)
		return out
	}
	if (node.type === "VariableDeclarator") for (const name of takenFrom(node, namespaces)) out.add(name)
	for (const [key, child] of Object.entries(node)) if (key !== "parent") destructuredFrom(child, namespaces, out)
	return out
}

/** Every named function of the file: declarations and functions bound to a const, at any depth. */
function functionsOf(node, out = new Map()) {
	if (typeof node !== "object" || node === null) return out
	if (Array.isArray(node)) {
		for (const child of node) functionsOf(child, out)
		return out
	}
	if (node.type === "FunctionDeclaration" && node.id) out.set(node.id.name, node.body)
	const init = node.type === "VariableDeclarator" ? node.init : undefined
	if (init && /^(?:Arrow)?Function(?:Expression)?$/.test(init.type) && node.id.type === "Identifier")
		out.set(node.id.name, init.body)
	for (const [key, child] of Object.entries(node)) if (key !== "parent") functionsOf(child, out)
	return out
}

function isSpawnMember(node, namespaces) {
	if (node.type !== "MemberExpression" || node.computed || node.object.type !== "Identifier") return false
	const name = node.property.name
	return node.object.name === "Bun" ? BUN_SPAWN.has(name) : (namespaces.get(node.object.name)?.has(name) ?? false)
}

/* a function kept as a property or method (a Vite plugin's hook) is a callback for later: the call that builds
 * the object does not run it, so httpApp() spawns nothing until Vite calls buildStart */
const KEPT = new Set(["MethodDefinition", "Property", "PropertyDefinition"])
const isKeptFunction = (node) => KEPT.has(node.type) && /Function/.test(node.value?.type ?? "")

/* a key, or a member's non-computed property, is a name, not a reference */
const isName = (node, key) => key === "parent" || key === "key" || (key === "property" && !node.computed)

/** Whether `node` calls or hands on anything that spawns: a primitive, a spawning name, Bun's. */
export function spawnsIn(node, scope) {
	if (typeof node !== "object" || node === null) return false
	if (Array.isArray(node)) return node.some((child) => spawnsIn(child, scope))
	if (isSpawnMember(node, scope.namespaces)) return true
	if (node.type === "Identifier") return scope.names.has(node.name)
	if (isKeptFunction(node)) return false
	return Object.entries(node).some(([key, child]) => !isName(node, key) && spawnsIn(child, scope))
}

/** The names that spawn when called in the file at repo path `from`, its own spawning functions included. */
export function spawnScope(program, from, helpers = SPAWNING_HELPERS) {
	const scope = importsOf(program, from, helpers)
	for (const name of destructuredFrom(program.body, scope.namespaces)) scope.names.add(name)
	const functions = functionsOf(program.body)
	for (let grew = true; grew;) {
		grew = false
		for (const [name, body] of functions) {
			if (scope.names.has(name) || !spawnsIn(body, scope)) continue
			scope.names.add(name)
			grew = true
		}
	}
	return scope
}
