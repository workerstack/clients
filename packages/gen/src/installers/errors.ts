/** A user-facing error: the CLI prints its message without a stack. */
export class InstallgenError extends Error {
	/** Always `"InstallgenError"`, so a caught error is told apart from any other by name across realms. */
	override name = "InstallgenError"
}
