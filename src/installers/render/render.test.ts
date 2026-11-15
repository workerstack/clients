import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { assertStructure } from "../../../tests/installers/support/structure.ts";
import { SPAWN_TIMEOUT } from "../../gen/__fixtures__/spawn-timeout.ts";
import type { InstallgenConfig, PathContext } from "../config/define-config.ts";
import { resolveConfig } from "../config/resolve.ts";
import { placeholders, readTemplates, render } from "./render.ts";

const base = {
  assetPath: ({ tag, version, os, arch }) =>
    `${tag}/my-cli_${version}_${os}_${arch}${os === "windows" ? ".zip" : ".tar.gz"}`,
  baseUrl: "https://dl.example.com/my-cli",
  checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
  name: "my-cli",
} satisfies InstallgenConfig;

const resolve = (overrides: Partial<InstallgenConfig> = {}) => resolveConfig({ ...base, ...overrides });

/** `sh -n` over the script: its exit status and what it reported. */
function shSyntax(script: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "installgen-render-"));

  try {
    writeFileSync(join(dir, "install.sh"), script);
    const result = spawnSync("sh", ["-n", join(dir, "install.sh")], { encoding: "utf8" });

    return { status: result.status, stderr: result.stderr };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("render", () => {
  test(
    "renders both scripts that meet the structural contract, https",
    () => {
      const out = render(resolve(), {});
      assertStructure(out, true);
      const syntax = shSyntax(out.sh as string);
      expect(syntax.status, syntax.stderr).toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  test("loopback http baseUrl: no https-only flags", () => {
    const out = render(resolve({ baseUrl: "http://127.0.0.1:8080" }), {});
    assertStructure(out, false);
    expect(out.sh).not.toContain("--proto");
    expect(out.sh).not.toContain("--https-only");
    expect(placeholders(resolve({ baseUrl: "http://127.0.0.1:8080" }), {}).sh.WGET_FLAGS).toBe("''");
  });

  test("fills every placeholder of the real templates, and every value is used", () => {
    const templates = readTemplates();
    const values = placeholders(resolve(), {});

    for (const kind of ["sh", "ps1"] as const) {
      const used = new Set([...templates[kind].matchAll(/@@([A-Z0-9_]+)@@/g)].map((m) => m[1]));
      expect([...used].toSorted()).toEqual(Object.keys(values[kind]).toSorted());
    }
  });

  test("install.ps1 refuses an https to http redirect on both download paths", () => {
    const ps1 = render(resolve(), {}).ps1 as string;
    expect(ps1).toContain("# installgen:begin Assert-HttpsKept");
    expect(ps1).toContain("# installgen:end Assert-HttpsKept");
    expect(ps1).toMatch(/function Assert-HttpsKept\(/);
    // after GetResponse() in the progress path, and on the -PassThru response of the Invoke-WebRequest fallback
    expect(ps1).toMatch(/GetResponse\(\)[\s\S]{0,200}Assert-HttpsKept -Requested \$Url -Final \$response\.ResponseUri/);
    expect(ps1).toMatch(/Invoke-WebRequest -UseBasicParsing -Uri \$Url -OutFile \$Path -PassThru/);
    expect(ps1).toMatch(/Assert-HttpsKept -Requested \$Url -Final \$final/);
  });

  test("an unknown placeholder in a template is an error", () => {
    expect(() => render(resolve(), {}, { ps1: "", sh: "#!/bin/sh\n@@NOPE@@\n" })).toThrow(
      /unknown placeholder @@NOPE@@ in install\.sh/,
    );
  });
});

describe("render", () => {
  test("a script is skipped when its OS has no platforms", () => {
    const unix = render(resolve({ platforms: ["linux/amd64", "darwin/arm64"] }), {});
    expect(unix.sh).toBeDefined();
    expect(unix.ps1).toBeUndefined();
    const win = render(resolve({ platforms: ["windows/amd64"] }), {});
    expect(win.sh).toBeUndefined();
    expect(win.ps1).toBeDefined();
  });

  test("without Unix platforms the ps1 hint has no sh URL", () => {
    expect(placeholders(resolve({ platforms: ["windows/amd64"] }), {}).ps1.SH_URL).toBe("''");
    expect(placeholders(resolve({ platforms: ["darwin/arm64", "windows/amd64"] }), {}).ps1.SH_URL).toBe(
      "'https://dl.example.com/my-cli/install.sh'",
    );
  });

  test("without Windows platforms the sh hint has no ps1 URL", () => {
    expect(placeholders(resolve({ platforms: ["linux/amd64"] }), {}).sh.PS1_URL).toBe("''");
    expect(placeholders(resolve({ platforms: ["linux/amd64", "windows/arm64"] }), {}).sh.PS1_URL).toBe(
      "'https://dl.example.com/my-cli/install.ps1'",
    );
  });

  test("the platform list and cases only name the configured platforms", () => {
    const values = placeholders(resolve({ platforms: ["linux/amd64", "darwin/arm64", "windows/arm64"] }), {});
    expect(values.sh.PLATFORMS).toBe("'linux/amd64' | 'darwin/arm64'");
    expect(values.ps1.PLATFORMS).toBe("@('windows/arm64')");
    expect(values.sh.PLATFORM_CASES).toContain("'linux/amd64')");
    expect(values.sh.PLATFORM_CASES).not.toContain("windows");
    expect(values.ps1.PLATFORM_CASES).toContain("'windows/arm64' {");
    expect(values.ps1.PLATFORM_CASES).not.toContain("linux");
  });
});

const dir = (installDir: string) => placeholders(resolve({ installDir }), {}).ps1.INSTALL_DIR;

describe("placeholder values", () => {
  test("sh", () => {
    const values = placeholders(resolve({ message: "Run 'my-cli --help'." }), { defaultVersion: "v1.2.3" });
    expect(values.sh).toMatchObject({
      BASE_URL: "'https://dl.example.com/my-cli'",
      CURL_FLAGS: "--proto '=https' --tlsv1.2",
      DEFAULT_VERSION: "'v1.2.3'",
      ENV_PREFIX: "MY_CLI",
      INSTALL_DIR: `"$HOME"'/.my-cli/bin'`,
      INSTALL_DIR_DISPLAY: "'~/.my-cli/bin'",
      LATEST_URL: "'https://dl.example.com/my-cli/latest'",
      MESSAGE: `'Run '\\''my-cli --help'\\''.'`,
      MODIFY_PATH: "1",
      NAME: "'my-cli'",
      PS1_URL: "'https://dl.example.com/my-cli/install.ps1'",
      SH_URL: "'https://dl.example.com/my-cli/install.sh'",
      TAG_PREFIX: "'v'",
      WGET_FLAGS: "'--https-only'",
    });
    expect(values.sh.PLATFORM_CASES).toContain(
      [
        "\t\t'linux/amd64')",
        `\t\t\tasset_path="$tag"'/my-cli_'"$version"'_linux_amd64.tar.gz'`,
        "\t\t\tformat='tar.gz'",
        `\t\t\tchecksums_path="$tag"'/checksums.txt'`,
        "\t\t\tbundle_path=''",
        "\t\t\tidentity=''",
        "\t\t\tissuer=''",
        "\t\t\tbinary_in_archive=''",
        "\t\t\t;;",
      ].join("\n"),
    );
  });
});

describe("placeholder values", () => {
  test("ps1", () => {
    const values = placeholders(resolve({ message: "It's done", modifyPath: false }), {});
    expect(values.ps1).toMatchObject({
      BASE_URL: "'https://dl.example.com/my-cli'",
      DEFAULT_VERSION: "''",
      ENV_PREFIX: "MY_CLI",
      INSTALL_DIR:
        "[IO.Path]::Combine([string[]](@([Environment]::GetFolderPath('UserProfile')) + @('.my-cli', 'bin')))",
      INSTALL_DIR_DISPLAY: "'~\\.my-cli\\bin'",
      LATEST_URL: "'https://dl.example.com/my-cli/latest'",
      MESSAGE: "'It''s done'",
      MODIFY_PATH: "$false",
      NAME: "'my-cli'",
      PS1_URL: "'https://dl.example.com/my-cli/install.ps1'",
      SH_URL: "'https://dl.example.com/my-cli/install.sh'",
      TAG_PREFIX: "'v'",
    });
    expect(values.ps1.PLATFORM_CASES).toContain(
      [
        "\t\t'windows/amd64' {",
        "\t\t\t$assetPath = ($tag + '/my-cli_' + $ver + '_windows_amd64.zip')",
        "\t\t\t$format = 'zip'",
        "\t\t\t$checksumsPath = ($tag + '/checksums.txt')",
        "\t\t\t$bundlePath = ''",
        "\t\t\t$identity = ''",
        "\t\t\t$issuer = ''",
        "\t\t\t$binaryInArchive = ''",
        "\t\t}",
      ].join("\n"),
    );
  });
});

describe("placeholder values", () => {
  test("the ps1 install dir is one quoted literal per segment, joined natively", () => {
    expect(dir("~/My Tools/bin")).toBe(
      "[IO.Path]::Combine([string[]](@([Environment]::GetFolderPath('UserProfile')) + @('My Tools', 'bin')))",
    );
    expect(dir("~/.local/bin")).toContain("+ @('.local', 'bin')))");
    expect(dir("~/tools")).toContain("+ @('tools')))");
    expect(dir("~/a/b/c")).not.toContain("\\");
  });

  test("no message, no checksums, a binaryInArchive", () => {
    const values = placeholders(
      resolve({
        binaryInArchive: ({ os }: PathContext) => `bin/${os}/my-cli`,
        checksumsPath: undefined,
      }),
      {},
    );

    expect(values.sh.MESSAGE).toBe("''");
    expect(values.ps1.MESSAGE).toBe("''");
    expect(values.sh.PLATFORM_CASES).toContain(
      "\t\t\tchecksums_path=''\n\t\t\tbundle_path=''\n\t\t\tidentity=''\n\t\t\tissuer=''\n\t\t\tbinary_in_archive='bin/linux/my-cli'",
    );
    expect(values.ps1.PLATFORM_CASES).toContain(
      "\t\t\t$checksumsPath = ''\n\t\t\t$bundlePath = ''\n\t\t\t$identity = ''\n\t\t\t$issuer = ''\n\t\t\t$binaryInArchive = 'bin/windows/my-cli'",
    );
  });

  test("a signature: the bundle, the tag-bound identity and the issuer, per platform", () => {
    const values = placeholders(
      resolve({
        signature: {
          identity: ({ tag }) => `https://github.com/acme/my-cli/.github/workflows/release.yml@refs/tags/${tag}`,
        },
      }),
      {},
    );

    expect(values.sh.PLATFORM_CASES).toContain(
      [
        `\t\t\tchecksums_path="$tag"'/checksums.txt'`,
        `\t\t\tbundle_path="$tag"'/checksums.txt.sigstore.json'`,
        `\t\t\tidentity='https://github.com/acme/my-cli/.github/workflows/release.yml@refs/tags/'"$tag"`,
        "\t\t\tissuer='https://token.actions.githubusercontent.com'",
      ].join("\n"),
    );
    expect(values.ps1.PLATFORM_CASES).toContain(
      [
        "\t\t\t$checksumsPath = ($tag + '/checksums.txt')",
        "\t\t\t$bundlePath = ($tag + '/checksums.txt.sigstore.json')",
        "\t\t\t$identity = ('https://github.com/acme/my-cli/.github/workflows/release.yml@refs/tags/' + $tag)",
        "\t\t\t$issuer = 'https://token.actions.githubusercontent.com'",
      ].join("\n"),
    );
  });
});

describe("ASCII and version checks", () => {
  test.each([
    ["message", { message: "Fertig ✓" }],
    ["baseUrl", { baseUrl: "https://dl.exämple.com" }],
    ["latestPath", { latestPath: "lätest" }],
    ["scriptUrls.sh", { scriptUrls: { ps1: "https://get.example.com/ps1", sh: "https://get.example.com/ß" } }],
    ["scriptUrls.ps1", { scriptUrls: { ps1: "https://get.example.com/ps1/é", sh: "https://get.example.com/sh" } }],
    ["assetPath", { assetPath: ({ version, os, arch }: PathContext) => `${version}/app-ü-${os}-${arch}.tar.gz` }],
    ["checksumsPath", { checksumsPath: ({ version }: PathContext) => `${version}/sümme.txt` }],
    ["binaryInArchive", { binaryInArchive: () => "bin/äpp" }],
    ["signature.identity", { signature: { identity: (): string => "https://ci.example.com/réléase" } }],
    [
      "signature.bundlePath",
      { signature: { bundlePath: (): string => "v1/sïg.json", identity: (): string => "https://ci.example.com/r" } },
    ],
    [
      "signature.issuer",
      { signature: { identity: (): string => "https://ci.example.com/r", issuer: "https://ïssuer.example.com" } },
    ],
  ])("a non-ASCII %s is rejected", (field, overrides) => {
    expect(() => render(resolve(overrides as Partial<InstallgenConfig>), {})).toThrow(
      new RegExp(`${field.replace(".", "\\.")} .*non-ASCII`),
    );
  });

  test("a non-ASCII byte from a template is caught too", () => {
    expect(() => render(resolve(), {}, { ps1: "", sh: "#!/bin/sh\n# café\n" })).toThrow(/install\.sh .*non-ASCII/);
  });

  test.each(["1.2.3", "v1.2.3", "1.2.3-rc.1+build.5", "2026.10.17"])(
    "--default-version %s is baked",
    (defaultVersion) => {
      expect(render(resolve(), { defaultVersion }).sh).toContain(`default_version='${defaultVersion}'`);
    },
  );

  test.each(["1.2.3 ", "1.2.3;rm", "$(x)", "1.2.3\n", "ü"])("an invalid --default-version %j", (defaultVersion) => {
    expect(() => render(resolve(), { defaultVersion })).toThrow(/default version/);
  });
});
