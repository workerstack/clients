/** What `release bump` was asked for: the release config, and whether every release is a major. */
export type BumpArgs = {
	/** The release config's path, relative to the working directory. */
	readonly config: string
	/** Make every package that releases a major, whatever changed. */
	readonly major: boolean
}

/** A parse that succeeded with `value`, or failed with an `error` to show the caller. */
export type Parsed<T> = { error: string; ok: false } | { ok: true; value: T }

/* Each flag takes the next argument as its value, unless that argument is a switch. */
const BUMP_FLAGS = { "--config": "config" } as const
/* Bare flags: present or not. */
const BUMP_SWITCHES = { "--major": "major" } as const

type Read<K extends string, S extends string> =
	| { set: Partial<Record<S, true>>; values: Partial<Record<K, string>> }
	| { unknown: string }

/* The value of every `flags` entry and the presence of every `switches` entry in `argv`, or the first argument that
 * is neither. */
function readFlags<K extends string, S extends string>(
	flags: Readonly<Record<string, K>>,
	switches: Readonly<Record<string, S>>,
	argv: readonly string[],
): Read<K, S> {
	const values: Partial<Record<K, string>> = {}
	const set: Partial<Record<S, true>> = {}
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] as string
		if (Object.hasOwn(switches, flag)) {
			set[switches[flag] as S] = true
			continue
		}
		if (!Object.hasOwn(flags, flag)) return { unknown: flag }
		const value = argv[i + 1]
		if (value === undefined || Object.hasOwn(switches, value)) continue
		values[flags[flag] as K] = value
		i++
	}
	return { set, values }
}

/** `release bump`'s flags: `--config <path>` (required) and `--major`; any other argument is an error naming it. */
export function parseBumpArgs(argv: readonly string[]): Parsed<BumpArgs> {
	const read = readFlags(BUMP_FLAGS, BUMP_SWITCHES, argv)
	if ("unknown" in read) return { error: `unknown flag: ${read.unknown}`, ok: false }
	const { config } = read.values
	if (!config) return { error: "--config <path> is required", ok: false }
	return { ok: true, value: { config, major: read.set.major === true } }
}
