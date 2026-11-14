/** The hex SHA-256 of `bytes`, on web crypto: the app runs on workerd, which has no node built-ins without a flag. */
export const sha256 = async (bytes: Uint8Array): Promise<string> =>
	Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")
