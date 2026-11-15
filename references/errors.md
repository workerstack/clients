---
description: Errors and the safe mirror
order: 70
---

# Errors and the safe mirror

Two styles, in all six SDKs, over the same calls:

- **The normal call** answers its value and throws on any failure: an error status as its typed error
  (`NotFoundError` and so on, each a `ClientError`), and an undecodable or over-cap 2xx as a `DecodeError`.
- **`client.safe`** holds the same calls, each answering a result. On `ok` it carries the data, the raw response, and
  the declared response headers when the operation has any. Otherwise it carries the error the normal call would have
  thrown, with the parsed body on it. A declared status narrows the error's type and body; any other status is the
  base client error with an `unknown` body.
- **No answer throws in both styles.** A call never sent, a refused or dropped connection, a timeout, a cancel, and a
  stream that drops after it opened are not answers, so there is nothing for a result to carry.

A name of yours that collides with the mirror, or with a runtime type, is renamed and reported on stderr — never
silently. An operation or root resource named `safe` becomes `safe_`, and a component named like one of the runtime
types becomes `<Name>Model`.

Full reference: [generated clients](https://github.com/workerstack/clients/blob/main/docs/client.md).
