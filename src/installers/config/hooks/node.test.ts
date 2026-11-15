import { describe, expect, test } from "vitest";

import { registerNodeHook, type RegisterHooks } from "./node.ts";

type Hooks = Parameters<RegisterHooks>[0];

const PACKAGE_NAME = "@workerstack/clients/installers";

const context = { conditions: [], importAttributes: {}, parentURL: undefined };

const unreachable = () => {
  throw new Error("not reached");
};

const passOn = (specifier: string) => ({ url: `file:///resolved/${specifier}` });

function capture(): { register: RegisterHooks; hooks: () => Hooks } {
  let hooks: Hooks | undefined;

  return {
    hooks: () => hooks as Hooks,
    register: (h) => {
      hooks = h;

      return { deregister: () => {} };
    },
  };
}

describe("registerNodeHook", () => {
  test("maps the package name to the running package, its format left to Node (index.ts from source, index.js built)", () => {
    const { register, hooks } = capture();
    registerNodeHook(PACKAGE_NAME, "file:///pkg/dist/index.js", register);
    expect(hooks().resolve?.(PACKAGE_NAME, context, unreachable)).toEqual({
      shortCircuit: true,
      url: "file:///pkg/dist/index.js",
    });
  });

  test("returns the deregister handle", () => {
    const handle = { deregister: () => {} };
    expect(registerNodeHook(PACKAGE_NAME, "file:///pkg/dist/index.js", () => handle)).toBe(handle);
  });

  test("passes every other specifier on", () => {
    const { register, hooks } = capture();
    registerNodeHook(PACKAGE_NAME, "file:///pkg/dist/index.js", register);
    expect(hooks().resolve?.("node:fs", context, passOn)).toEqual({ url: "file:///resolved/node:fs" });
    expect(hooks().resolve?.(`${PACKAGE_NAME}/package.json`, context, passOn)).toEqual({
      url: `file:///resolved/${PACKAGE_NAME}/package.json`,
    });
  });

  test("defaults to node:module registerHooks", async () => {
    const { default: module } = await import("node:module");
    const before = module.registerHooks;
    const calls: unknown[] = [];
    module.registerHooks = (hooks: Hooks) => {
      calls.push(hooks);

      return { deregister: () => {} };
    };

    try {
      registerNodeHook(PACKAGE_NAME, "file:///pkg/dist/index.js");
    } finally {
      module.registerHooks = before;
    }

    expect(calls).toHaveLength(1);
  });
});
