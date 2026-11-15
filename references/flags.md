---
description: Every generate flag
order: 50
---

# Every flag

One table, since a flag that is not written down is a flag nobody finds:

| Flag                       | Target | What it sets                                                                      |
| -------------------------- | ------ | --------------------------------------------------------------------------------- |
| `--spec <file>`            | —      | the OpenAPI document to generate from                                             |
| `--app <module>[#export]`  | —      | a backend app module instead of a document                                        |
| `--target <name>`          | —      | which target to emit; repeat for more than one                                    |
| `--out <dir>`              | —      | the output root; each target writes under `<dir>/<target>`                        |
| `--watch`                  | —      | regenerate on each change, in a fresh process                                     |
| `-h`, `--help`             | —      | the usage text                                                                    |
| `--ts-name`                | ts     | the client class's name (default `SDK`)                                           |
| `--ts-stem`                | ts     | the file stem the generated modules share                                         |
| `--ts-package-name`        | ts     | the npm name, and the JSR name when scoped; the stem by default                   |
| `--ts-version`             | ts     | the version both registries carry; the document's by default                      |
| `--ts-tanstack-query`      | ts     | also write the TanStack Query adapter; takes no value                             |
| `--go-module-path`         | go     | the Go module path the SDK is imported by                                         |
| `--go-version`             | go     | its semver; from v2 on, the major suffix (`/v2`) it puts on the module path       |
| `--rust-crate-name`        | rust   | the crate's name                                                                  |
| `--rust-version`           | rust   | the crate's version                                                               |
| `--rust-description`       | rust   | what crates.io shows; `cargo publish` needs one                                   |
| `--rust-license`           | rust   | its SPDX license; `cargo publish` needs one                                       |
| `--rust-repository`        | rust   | the repository crates.io links                                                    |
| `--rust-homepage`          | rust   | the home page crates.io links                                                     |
| `--rust-keywords`          | rust   | its crates.io keywords, comma separated: five at most, each 20 ASCII characters   |
| `--rust-categories`        | rust   | its crates.io category slugs, comma separated: five at most                       |
| `--rust-documentation`     | rust   | the https documentation crates.io links; docs.rs by default                       |
| `--python-package-name`    | python | the Python package's name                                                         |
| `--python-version`         | python | the package's version                                                             |
| `--csharp-client-name`     | csharp | the client class's name                                                           |
| `--csharp-package-id`      | csharp | the NuGet package id                                                              |
| `--csharp-root-namespace`  | csharp | the root namespace                                                                |
| `--csharp-version`         | csharp | the package's version                                                             |
| `--csharp-description`     | csharp | what nuget.org shows                                                              |
| `--csharp-authors`         | csharp | its authors, comma separated                                                      |
| `--csharp-license`         | csharp | its SPDX license expression                                                       |
| `--csharp-homepage`        | csharp | the https home page nuget.org links                                               |
| `--csharp-repository`      | csharp | the https URL of its git repository                                               |
| `--csharp-copyright`       | csharp | the copyright notice nuget.org shows                                              |
| `--csharp-tags`            | csharp | its NuGet tags, comma separated                                                   |
| `--java-artifact-id`       | java   | the Maven artifact id; `sdk` by default                                           |
| `--java-group-id`          | java   | the Maven group id; `com.example` by default, yours to publish                    |
| `--java-package-name`      | java   | the Java package name                                                             |
| `--java-client-name`       | java   | the client class's name                                                           |
| `--java-version`           | java   | the publication's version                                                         |
| `--java-description`       | java   | the POM's description; the document's by default                                  |
| `--java-homepage`          | java   | the POM's https project URL                                                       |
| `--java-license`           | java   | its SPDX license id, linked to spdx.org                                           |
| `--java-repository`        | java   | the https URL of its git repository, the POM's scm                                |
| `--java-developers`        | java   | the POM's developers, comma separated: each a name or `Name <email>`              |
| `--cli-binary-name`        | cli    | the command's own name (`shop`)                                                   |
| `--cli-base-url`           | cli    | the base URL it calls by default; the document's server by default                |
| `--cli-module-path`        | cli    | the Go module path the CLI is built from                                          |
| `--cli-version`            | cli    | its semver; from v2 on, the major suffix (`/v2`) it puts on the module path       |
| `--cli-repo`               | cli    | the GitHub repository its release workflow and install scripts use                |
| `--cli-env-prefix`         | cli    | the prefix of the environment variables it reads                                  |
| `--cli-install-url`        | cli    | the https directory its install scripts are served from; the release's by default |
| `--cli-description`        | cli    | what the package managers show; every channel needs one                           |
| `--cli-homepage`           | cli    | the home page the package managers link; every channel needs one                  |
| `--cli-license`            | cli    | its SPDX license; every channel needs one                                         |
| `--cli-maintainer`         | cli    | `Name <email>`, which AUR and the Linux packages name                             |
| `--cli-homebrew-tap`       | cli    | the Homebrew tap (`owner/name`) its cask is pushed to                             |
| `--cli-scoop-bucket`       | cli    | the Scoop bucket (`owner/name`) its manifest is pushed to                         |
| `--cli-winget-fork`        | cli    | the winget-pkgs fork (`owner/name`) its manifests are proposed from               |
| `--cli-winget-publisher`   | cli    | the publisher winget files it under                                               |
| `--cli-aur`                | cli    | a switch: publish the `<bin>-bin` AUR package                                     |
| `--cli-packages`           | cli    | Linux packages beside the archives: `deb`, `rpm`, `apk`, comma separated          |
| `--mcp-name`               | mcp    | the server's name, and the stem of its bin                                        |
| `--mcp-env-prefix`         | mcp    | the prefix of the environment variables it reads                                  |
| `--mcp-version`            | mcp    | its server info and package version; the document's by default                    |
| `--mcp-package-name`       | mcp    | the npm name it publishes under; `<name>-mcp` by default                          |
| `--mcp-mcp-name`           | mcp    | its MCP registry name (`io.github.acme/shop`), package.json's `mcpName`           |
| `--metadata-description`   | all    | what every registry shows                                                         |
| `--metadata-homepage`      | all    | the https home page the registries link                                           |
| `--metadata-repository`    | all    | the https URL of its git repository                                               |
| `--metadata-license`       | all    | its SPDX license expression                                                       |
| `--metadata-authors`       | all    | each `Name <email>` or a name, comma separated                                    |
| `--metadata-keywords`      | all    | registry keywords, comma separated                                                |
| `--metadata-copyright`     | all    | the copyright line                                                                |
| `--metadata-documentation` | all    | the https URL of its documentation                                                |
| `--metadata-changelog`     | all    | the https URL of its changelog                                                    |
| `--metadata-license-file`  | all    | the license file to ship in each package                                          |
| `--metadata-readme`        | all    | the README to ship in each package                                                |
| `--metadata-icon`          | all    | the package icon to ship where the registry shows one                             |

The `--metadata-<field>` flags fill one package block that every target which publishes reads where its registry has
a place for the field, so a description or license is given once, not once per target. A target's own option of the
same meaning wins: `--java-description` over `--metadata-description`. Each field is checked before anything
generates: URLs must be https, the license an SPDX expression, text one line.

`--metadata-readme` and `--metadata-license-file` name files on disk, read once relative to where clients runs. Every
target writes them into its package root as `README.md` and `LICENSE`, and each manifest points at the ones it has:
pyproject's `readme` and `license-files`, Cargo's `readme` and `include`, the `.csproj`'s `PackageReadmeFile` and packed
items, and jsr.json's publish list; npm packs both on its own. The README must be a `.md` file, and both must be UTF-8
text. `--metadata-icon` ships only into the C# package, as `icon` with its own extension in lower case (`icon.png`,
`icon.jpeg`) under `PackageIcon`, since nuget.org is the one registry that shows an icon: a PNG or JPEG whose bytes are
that image, at most 1 MB.
