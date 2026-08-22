import assert from "node:assert/strict";
import test from "node:test";
import { authorizePackageRequest, packagePolicy } from "./policy.mjs";

test("advertises authorization-only policy with disabled delivery", () => {
  assert.deepEqual(
    {
      mode: packagePolicy.mode,
      delivery: packagePolicy.delivery,
      claims: packagePolicy.claims,
    },
    {
      mode: "authorization-only",
      delivery: "disabled",
      claims: "unsupported",
    },
  );
});

test("accepts exact npm and PyPI registry versions", () => {
  assert.deepEqual(
    authorizePackageRequest({
      ecosystem: "npm",
      packages: ["zod@4.2.1", "@modelcontextprotocol/sdk@1.25.1"],
    }),
    {
      ecosystem: "npm",
      packages: ["zod@4.2.1", "@modelcontextprotocol/sdk@1.25.1"],
    },
  );
  assert.deepEqual(
    authorizePackageRequest({
      ecosystem: "pypi",
      packages: ["requests==2.32.5", "typing_extensions==4.15.0"],
    }),
    {
      ecosystem: "pypi",
      packages: ["requests==2.32.5", "typing_extensions==4.15.0"],
    },
  );
});

test("rejects ranges, tags, URLs, paths, options, and extras", () => {
  const denied = [
    { ecosystem: "npm", packages: ["zod@^4.2.1"] },
    { ecosystem: "npm", packages: ["zod@latest"] },
    { ecosystem: "npm", packages: ["git+https://example.test/a.git"] },
    { ecosystem: "pypi", packages: ["requests>=2"] },
    { ecosystem: "pypi", packages: ["requests[security]==2.32.5"] },
    { ecosystem: "pypi", packages: ["--index-url=https://example.test"] },
    { ecosystem: "pypi", packages: ["../package==1.0.0"] },
  ];

  for (const request of denied) {
    assert.throws(() => authorizePackageRequest(request));
  }
});

test("rejects unknown fields and unbounded requests", () => {
  assert.throws(() =>
    authorizePackageRequest({
      ecosystem: "npm",
      packages: ["zod@4.2.1"],
      registry: "https://example.test",
    }),
  );
  assert.throws(() =>
    authorizePackageRequest({
      ecosystem: "npm",
      packages: Array.from({ length: 33 }, (_, index) => `p${index}@1.0.0`),
    }),
  );
});
