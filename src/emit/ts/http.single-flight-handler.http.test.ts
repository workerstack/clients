/**
 * The single-flight handler's HTTP checks, before anything runs: the media type, the body size counted while it is
 * read, and the browser's own `Sec-Fetch-Site` and `Origin`; a caller that sends neither is no browser and passes.
 */
import { describe, expect, it } from "vitest";

import { post, problemOf, streamedPost } from "./__fixtures__/single-flight-wire.ts";
import { APP, batch, flightOf, paddedBatch, REFUSAL, UPDATE } from "./__fixtures__/single-flight.ts";

const BODY = batch(UPDATE.op, UPDATE.input);

/** The handler's status for a POST of BODY with `headers`, and how many requests reached the fake API. */
async function statusOf(headers: Readonly<Record<string, string>>, allowedOrigins?: readonly string[]) {
  const { calls, handle } = await flightOf({}, allowedOrigins === undefined ? {} : { allowedOrigins });
  const response = await handle(post(BODY, headers));

  return [response.status, calls.length];
}

/** The handler's refusal of a POST of BODY with `headers`, and how many requests reached the fake API. */
async function refusalOf(headers: Readonly<Record<string, string>>) {
  const { calls, handle } = await flightOf();
  const problem = await problemOf(await handle(post(BODY, headers)));

  return [problem, calls.length];
}

describe("singleFlightHandler: the media type", () => {
  it.each([
    ["text/plain", { "content-type": "text/plain" }],
    ["a form", { "content-type": "application/x-www-form-urlencoded" }],
    ["a look-alike", { "content-type": "application/jsonp" }],
    ["a JSON suffix", { "content-type": "application/problem+json" }],
  ])("refuses %s", async (_label, headers) => {
    expect(await refusalOf(headers)).toStrictEqual([REFUSAL, 0]);
  });

  it("refuses a body with no Content-Type", async () => {
    const { calls, handle } = await flightOf();
    const request = new Request(`${APP}/api/_mutate`, { body: new Blob([JSON.stringify(BODY)]), method: "POST" });
    expect([await problemOf(await handle(request)), calls.length]).toStrictEqual([REFUSAL, 0]);
  });

  it.each([
    ["with a charset", "application/json; charset=utf-8"],
    ["in upper case", "Application/JSON"],
  ])("takes application/json %s", async (_label, type) => {
    expect(await statusOf({ "content-type": type })).toStrictEqual([200, 1]);
  });
});

describe("singleFlightHandler: the body size", () => {
  it("refuses a body over maxBodyBytes", async () => {
    const { calls, handle } = await flightOf({}, { maxBodyBytes: 1024 });
    const problem = await problemOf(await handle(post(paddedBatch(2048))));
    expect([problem, calls.length]).toStrictEqual([REFUSAL, 0]);
  });

  it("refuses a body over the 64 KiB default", async () => {
    const { calls, handle } = await flightOf();
    const problem = await problemOf(await handle(post(paddedBatch(65 * 1024))));
    expect([problem, calls.length]).toStrictEqual([REFUSAL, 0]);
  });

  it("counts a streamed body with no Content-Length while it reads, and stops reading", async () => {
    const pulled = { bytes: 0 };
    const { calls, handle } = await flightOf({}, { maxBodyBytes: 1024 });
    const problem = await problemOf(await handle(streamedPost(paddedBatch(256 * 1024), pulled)));
    expect([problem, calls.length, pulled.bytes < 64 * 1024]).toStrictEqual([REFUSAL, 0, true]);
  });

  it("takes a body under maxBodyBytes", async () => {
    const { calls, handle } = await flightOf({}, { maxBodyBytes: 4096 });
    const response = await handle(post(paddedBatch(1024)));
    expect([response.status, calls.length]).toStrictEqual([200, 1]);
  });
});

describe("singleFlightHandler: the browser's Sec-Fetch-Site and Origin", () => {
  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }],
    ["another Origin", { origin: "https://evil.test" }],
    ["a sibling Origin", { origin: "https://api.app.test" }],
    ["the origin on another port", { origin: "https://app.test:8443" }],
    ["Origin null", { origin: "null" }],
    ["same-origin with another Origin", { origin: "https://evil.test", "sec-fetch-site": "same-origin" }],
  ])("refuses %s", async (_label, headers) => {
    expect(await refusalOf(headers)).toStrictEqual([REFUSAL, 0]);
  });

  it.each([
    ["neither header: no browser", {}],
    ["Sec-Fetch-Site same-origin", { "sec-fetch-site": "same-origin" }],
    ["its own Origin", { origin: APP }],
    ["both its own", { origin: APP, "sec-fetch-site": "same-origin" }],
  ])("takes %s", async (_label, headers) => {
    expect(await statusOf(headers)).toStrictEqual([200, 1]);
  });

  it("takes an Origin in allowedOrigins", async () => {
    expect(await statusOf({ origin: "https://admin.test" }, ["https://admin.test"])).toStrictEqual([200, 1]);
  });

  it("refuses its own Origin when allowedOrigins leaves it out", async () => {
    const { calls, handle } = await flightOf({}, { allowedOrigins: ["https://admin.test"] });
    const problem = await problemOf(await handle(post(BODY, { origin: APP })));
    expect([problem, calls.length]).toStrictEqual([REFUSAL, 0]);
  });
});
