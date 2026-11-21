/**
 * The Java `onInvalidate` cases' programs (http.on-invalidate.test.ts, http.on-invalidate.hooks.test.ts): plan 2's
 * document (shared/__fixtures__/documents-invalidate.ts) as the Java SDK, `safe_()` beside `safe()` among its members,
 * and a probe in the SDK's package around a case's body, aimed at the recording server: `section` starts a section,
 * `note` adds to it, `shown` is an event as one note, `recorded` builds a client whose hooks note each event and whose
 * log notes each hook error, `next` is what a queue holds within 2 s. Its notes print as one JSON object.
 */
import { invalidateDocument } from "../../shared/__fixtures__/documents-invalidate.ts"
import { generateJavaSdk } from "../sdk.ts"
import type { JavaRun } from "./compiled.ts"

/** The probe's class. */
export const MAIN = "com.example.InvalidateProbe"

/** The SDK's files for plan 2's document. */
export function sdkFiles(): Readonly<Record<string, string>> {
	return generateJavaSdk(invalidateDocument()).files
}

/** The probe around `body` (statements of `main`), its clients aimed at `url`. */
export function probe(url: string, body: string): string {
	const indented = body
		.split("\n")
		.map((line) => (line === "" ? "" : `    ${line}`))
		.join("\n")
	return `package com.example;

import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

public class InvalidateProbe {
  static final String BASE = ${JSON.stringify(url)};
  static final Map<String, List<String>> OUT = new LinkedHashMap<>();
  static String at = "main";

  static void section(String name) {
    at = name;
  }

  static synchronized void note(Object value) {
    OUT.computeIfAbsent(at, k -> new ArrayList<>()).add(String.valueOf(value));
  }

  static ExampleClient.Builder base() {
    return ExampleClient.builder().baseUrl(BASE);
  }

  static String shown(InvalidateEvent e) {
    List<String> parts = new ArrayList<>(List.of(e.by()));
    for (InvalidateTarget t : e.targets()) {
      List<String> pairs = new ArrayList<>();
      new TreeMap<>(t.params()).forEach((key, value) -> pairs.add(key + "=" + value));
      parts.add(t.operationId() + " [" + String.join(" ", pairs) + "]");
    }
    return String.join(" | ", parts);
  }

  static ExampleClient recorded(ExampleClient.Builder builder, InvalidateHook... hooks) {
    for (InvalidateHook hook : hooks) {
      builder.onInvalidate(hook);
    }
    return builder
        .onInvalidate(e -> note("invalidated " + shown(e)))
        .onLog(entry -> {
          if (entry.error() != null && entry.error().contains("boom")) {
            note("log " + entry.level() + " " + entry.event());
          }
        })
        .build();
  }

  static String next(BlockingQueue<String> seen) throws InterruptedException {
    String e = seen.poll(2, TimeUnit.SECONDS);
    return e == null ? "none" : e;
  }

  public static void main(String[] args) throws Exception {
${indented}
    System.out.println(Json.MAPPER.writeValueAsString(OUT));
    System.exit(0);
  }
}
`
}

/** What a case reads of a probe's run: whether it ran to its end, and the notes of `section`. */
export function notesOf(run: JavaRun, section: string) {
	const ran = run.status === 0
	const out = ran ? (JSON.parse(run.stdout) as Readonly<Record<string, string[]>>)[section] : undefined
	return { out: ran ? (out ?? []) : undefined, ran }
}

/** A probe's failure as a case shows it: javac's diagnostics, then the program's stderr. */
export function failureOf(run: JavaRun): string {
	return `${run.diagnostics.join("\n")}${run.stderr}`
}
