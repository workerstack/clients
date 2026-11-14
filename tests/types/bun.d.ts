/**
 * The slice of Bun's global that the two files run under Bun call: the conformance launcher's `Bun.build` and the
 * OAuth world's `Bun.serve`. `@types/bun` changes the `fetch` and `File` types every other test here is
 * checked against, so only what these call is declared.
 */
declare const Bun: {
	build(options: {
		readonly conditions: readonly string[]
		readonly entrypoints: readonly string[]
		readonly files: Readonly<Record<string, string>>
		readonly format: "esm"
		readonly target: "browser"
	}): Promise<{
		readonly logs: readonly unknown[]
		readonly outputs: readonly { text(): Promise<string> }[]
		readonly success: boolean
	}>
	serve(options: {
		fetch(request: Request): Response | Promise<Response>
		readonly hostname: string
		readonly port: number
	}): { readonly port: number; stop(closeActiveConnections?: boolean): Promise<void> }
}
