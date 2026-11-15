import { describe, expectTypeOf, test } from "vitest";

import {
  defineConfig,
  type Arch,
  type InstallgenConfig,
  type Os,
  type Platform,
  type SignatureConfig,
  type TagToken,
  type VersionToken,
} from "./define-config.ts";

describe("config types", () => {
  test("path functions receive tokens and the real os and arch", () => {
    defineConfig({
      assetPath: (ctx) => {
        expectTypeOf(ctx.version).toEqualTypeOf<VersionToken>();
        expectTypeOf(ctx.tag).toEqualTypeOf<TagToken>();
        expectTypeOf(ctx.os).toEqualTypeOf<Os>();
        expectTypeOf(ctx.arch).toEqualTypeOf<Arch>();

        return `${ctx.version}/app`;
      },
      baseUrl: "https://dl.example.com",
      checksumsPath: (ctx) => {
        expectTypeOf(ctx.asset).toEqualTypeOf<string>();

        return `${ctx.asset}.sha256`;
      },
      name: "app",
    });
  });

  test("string methods on a token are type errors", () => {
    const config = defineConfig({
      assetPath: ({ version, tag }) => {
        // @ts-expect-error a token is not a string; interpolate it instead
        version.toUpperCase();
        // @ts-expect-error a token is not a string; interpolate it instead
        tag.slice(1);

        return `${tag}/${version}`;
      },
      baseUrl: "https://dl.example.com",
      name: "app",
    });

    expectTypeOf(config).toEqualTypeOf<InstallgenConfig>();
  });

  test("os and arch only take the supported names", () => {
    const config = defineConfig({
      assetPath: ({ version, os, arch }) => {
        // @ts-expect-error os is "linux" | "darwin" | "windows"
        const mac = os === "macos";
        // @ts-expect-error arch uses Go names
        const x64 = arch === "x86_64";

        return `${version}/${mac}-${x64}`;
      },
      baseUrl: "https://dl.example.com",
      name: "app",
    });

    expectTypeOf(config).toEqualTypeOf<InstallgenConfig>();
  });
});

describe("config types", () => {
  test("Platform rejects unknown pairs", () => {
    expectTypeOf<"linux/amd64">().toExtend<Platform>();
    expectTypeOf<"windows/arm64">().toExtend<Platform>();
    // @ts-expect-error 386 is not supported
    const bad: Platform = "linux/386";
    void bad;
  });

  test("a type-only config with satisfies", () => {
    const config = {
      assetPath: ({ version, os, arch }) => `${version}/app-${os}-${arch}`,
      baseUrl: "https://dl.example.com",
      name: "app",
      platforms: ["linux/amd64", "darwin/arm64"],
    } satisfies InstallgenConfig;

    expectTypeOf(config).toExtend<InstallgenConfig>();

    const missing = {
      name: "app",
      assetPath: ({ version }) => `${version}/app`,
      // @ts-expect-error baseUrl is required
    } satisfies InstallgenConfig;

    void missing;
  });

  test("signature: identity is a function of the path context; bundlePath and issuer are optional", () => {
    defineConfig({
      assetPath: ({ version }) => `${version}/app`,
      baseUrl: "https://dl.example.com",
      checksumsPath: ({ tag }) => `${tag}/checksums.txt`,
      name: "app",
      signature: {
        identity: (ctx) => {
          expectTypeOf(ctx.tag).toEqualTypeOf<TagToken>();

          return `https://github.com/o/r/.github/workflows/release.yml@refs/tags/${ctx.tag}`;
        },
      },
    });
    expectTypeOf<SignatureConfig["bundlePath"]>().toEqualTypeOf<SignatureConfig["bundlePath"] | undefined>();
    expectTypeOf<SignatureConfig["issuer"]>().toEqualTypeOf<string | undefined>();

    const signature: SignatureConfig = {
      bundlePath: (ctx) => {
        expectTypeOf(ctx.checksums).toEqualTypeOf<string>();
        expectTypeOf(ctx.asset).toEqualTypeOf<string>();

        return `${ctx.checksums}.sigstore.json`;
      },
      identity: () => "https://github.com/o/r/.github/workflows/release.yml@refs/heads/main",
    };

    void signature;
    // @ts-expect-error identity is a function, not a string
    const fixed: SignatureConfig = { identity: "https://github.com/o/r" };
    void fixed;
  });
});
