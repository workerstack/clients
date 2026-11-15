---
description: The six SDKs
order: 60
---

# The six SDKs

Every SDK takes the same configuration — a base URL, the auth the spec's security scheme names, a timeout, retries,
hooks around each HTTP call, and per-call overrides — and every one answers the same way: the normal call returns
your value and throws a typed error by status, while `client.safe` answers a result instead. What follows is each
language's client in a slice of a compiled example; the
[SDK recipes](https://github.com/workerstack/clients/blob/main/docs/sdk-recipes.md) page has the whole programs.

## The TypeScript SDK

```sh
clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen
```

```ts sdk
import { DecodeError, Kitchen, NotFoundError } from "./kitchen"

export function newClient(): Kitchen {
	return new Kitchen({
		baseURL: "https://api.example.com",
		headers: { authorization: `Bearer ${process.env.KITCHEN_TOKEN ?? ""}` },
		timeout: 10_000,
	})
}

export async function organization(client: Kitchen, orgId: string): Promise<string | null> {
	try {
		await client.organizations.retrieve({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function health(client: Kitchen): Promise<string> {
	const result = await client.safe.health.check()
	if (result.ok) return "up"
	if (result.error instanceof DecodeError) return `unreadable answer: ${result.error.message}`
	return `answered ${result.error.status}`
}
```

### Publishing it to npm and JSR

The target writes a package around the SDK, so the output directory publishes as it is. The sources stay where a
workspace imports them; they import each other as `.js`, which every TypeScript resolution and bundler maps to the
`.ts` file. Node will not strip types under `node_modules`, so `dist/` holds each source compiled to ES module
JavaScript beside its declarations, and `package.json` exports those: the root, `./webhook` when the document has
webhook events, and `./tanstack-query` with `@tanstack/query-core` as an optional peer. A scoped `--ts-package-name`
also gets a `jsr.json` that publishes the sources themselves, its `.js` imports mapped to their `.ts` files.
`--metadata-*` fills description, keywords, homepage, bugs, license, author and repository.

```sh
clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen \
  --ts-package-name @acme/kitchen --ts-version 1.4.0 --metadata-license MIT
```

### TanStack Query, from the same document

`--ts-tanstack-query` writes one more file beside the SDK, `<stem>.tanstack-query.gen.ts`. It takes no value:

```sh
clients generate --spec openapi.json --target ts --out generated --ts-name Kitchen --ts-tanstack-query
```

Its `createQueryHelpers(sdk, { getQueryClient })` gives five surfaces — `query`, `mutation`, `infiniteQuery`,
`queryKey` and `mutationKey` — each nested exactly as the client is, so `query.org.member.list(…)` sits where
`client.org.member.list(…)` does. `sdk` may be a client or a thunk for one, which an isomorphic app needs.

The document decides what goes where. A `GET` is on `query`, every other method is on `mutation`, and an event
stream, a WebSocket or an `x-realtime` operation is on neither, because a stream is not a cache entry. Nothing
is keyed off a method's name.

**Keys.** A read's key is `[<SDK name>, ...the member path, the request]` — the request object whole, so
`params`, `search` and anything else the SDK sends are all in it. That is what TanStack requires: every input
the `queryFn` depends on belongs in the key, so two reads of one route that differ only by `search` are two
cache entries. `init` is not in the key, since a signal and a timeout say nothing about the answer. A read with
no request keys as `[<SDK name>, ...the member path]`. `queryKey.<…>(req)` returns exactly the key
`query.<…>({ reqOptions: { req } })` writes. A paged read carries a trailing `"infinite"` marker, because its
cached shape is `InfiniteData` and it must not share the plain read's entry.

**Invalidation** works by prefix, which is why the two are not the same shape. A successful write makes stale
the reads its `x-invalidate` selectors name, with the mutation's own path params filled in:
`[<SDK name>, ...the member path, { params }]`. TanStack matches objects partially and compares only the
filter's own positions, so that reaches every search of that read, the paged entry included. When a selector's
params are not all known the filter stays the bare prefix, which reaches everything under it — made stale
rather than missed.

Two notes. `@tanstack/query-core` is your dependency, not backend's — install it yourself; the file imports it for
types only. And a read's options carry `initialData: undefined`, which is what solid-query needs to keep the
unseeded overload; it is harmless under react-query.

Drop the flag and the next run deletes the file, the way `.clients-generated.json` deletes anything the previous
run wrote and this one did not. The index file never re-exports the adapter, so an SDK generated without the
flag names no TanStack type anywhere.

## The Go SDK

Idiomatic Go: a `Config`, `context.Context` on every call, errors read with `errors.As`, and an event stream as a
`range` over a function.

```sh
clients generate --spec openapi.json --target go --out generated --go-module-path github.com/acme/shop/sdk
```

Go wants a v2-or-later module's major version at the end of its path, so pass the base path and the version:
`--go-version 2.1.0` makes go.mod declare `github.com/acme/shop/sdk/v2`, and the CLI target's `--cli-version` does the
same for its module and the version it links in. A path Go would not publish (no domain first, or a suffix such as
`/v1`) is refused, as is a suffix next to a version, since the version gives it.

```go
func listing(ctx context.Context, client *sdk.Client) string {
	r, err := client.Safe().Root.List(ctx, nil)
	if err != nil {
		return fmt.Sprintf("no answer: %v", err) // never sent, refused, dropped, timed out or canceled
	}
	var unreadable *sdk.DecodeError
	var failed *sdk.ClientError
	switch {
	case r.Ok():
		return fmt.Sprintf("answered %d: %v", r.Response.StatusCode, r.Data)
	case errors.As(r.Err, &unreadable):
		return fmt.Sprintf("answered %d, unreadable: %v", r.Response.StatusCode, unreadable.Err)
	case errors.As(r.Err, &failed):
		return fmt.Sprintf("answered %d: %s", failed.StatusCode, failed.Key)
	}
	return r.Err.Error()
}
```

## The Rust SDK

Async over `reqwest`, each call taking its options struct, with the safe mirror as a second client style.

```sh
clients generate --spec openapi.json --target rust --out generated --rust-crate-name shop-sdk
```

```rust
async fn listing(client: &Client) -> String {
    match client.safe().root().list(&RootListOpts::default()).await {
        Ok(Answer::Ok { data, response }) => format!("answered {}: {data:?}", response.status),
        Ok(Answer::Err {
            error: SafeError::Api(failed),
            response,
        }) => format!("answered {}: {}", response.status, failed.message()),
        Ok(Answer::Err {
            error: SafeError::Decode(unreadable),
            response,
        }) => format!("answered {}, unreadable: {unreadable}", response.status),
        Err(no_answer) => format!("no answer: {no_answer}"), // never sent, refused, timed out or canceled
    }
}
```

## The Python SDK

A sync `SDK` and an async `AsyncSDK`, both context managers, typed for `mypy --strict`, with results as frozen
dataclasses to narrow with `match`.

```sh
clients generate --spec openapi.json --target python --out generated --python-package-name shop_sdk
```

`pyproject.toml` builds with hatchling and carries what PyPI shows: `--metadata-*` gives the description, the SPDX
`license` (PEP 639, so no `License ::` classifier), authors, keywords, and `[project.urls]` (Homepage, Source,
Issues, Documentation, Changelog). The classifiers name the Python versions clients tests and `Typing :: Typed`, and
clients' own manifest stays out of the sdist.

```python
async def health(client: AsyncSDK) -> str:
    match await client.safe.health.check():
        case Ok(data, response):
            return f"answered {response.status}: {data}"
        case Err(DecodeError() as unreadable, response):
            return f"answered {response.status}, unreadable: {unreadable}"
        case Err(error, response):
            return f"answered {response.status}: {error}"
```

## The C# SDK

A .NET project with its own `HttpClient` pipeline, `IAsyncDisposable` streams, and `client.Safe` answering
`Result<T>`.

```sh
clients generate --spec openapi.json --target csharp --out generated --csharp-package-id Acme.Shop
```

nuget.org shows a package's description, authors, license and links: give them with `--csharp-description`,
`--csharp-authors`, `--csharp-license`, `--csharp-homepage` and `--csharp-repository`, and the `.csproj` carries them
into `dotnet pack`.

```csharp
    public static async Task<string> Listing(HttpSdkClient client, string id)
    {
        var result = await client.Safe.Root.ListAsync(id); // no answer (never sent, refused, timed out, canceled) still throws
        return result.Match(
            found => $"answered {result.Response.Status}: {found}",
            error => error switch
            {
                DecodeException unreadable => $"answered {result.Response.Status}, unreadable: {unreadable.Message}",
                ApiStatusException failed => $"answered {failed.Status}: {failed.Key}",
                _ => error.Message,
            });
    }
```

## The Java SDK

A Java 17 library on Jackson 3, with builders, `try`-with-resources streams, `client.safe()` answering a sealed
`Result<T>`, and a Gradle publication.

```sh
clients generate --spec openapi.json --target java --out generated --java-group-id com.acme
```

Maven Central refuses a POM without a URL, a license, a developer and scm: give them with `--java-homepage`,
`--java-license`, `--java-developers "Name <email>, Other Name"` and `--java-repository`, or once for every target in
the metadata block, whose authors are the POM's developers. Signing the publication stays yours.

```java
  static String listing(KitchenClient client) {
    // no answer (never sent, refused, timed out, canceled) still throws
    Result<ListApiResponse200> result = client.safe().root().list(RootListParams.builder().build());
    int status = result.response().status();
    return result.fold(
        found -> "answered " + status + ": " + found,
        error ->
            error instanceof ApiException failed
                ? "answered " + status + ": " + failed.key()
                : "answered " + status + ", unreadable: " + error.getMessage());
  }
```
