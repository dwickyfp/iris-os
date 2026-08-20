const MAX_PACKAGES = 32;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PYTHON_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PYTHON_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

function validateNpm(spec) {
  const separator = spec.lastIndexOf("@");
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  return separator > 0 && NPM_NAME.test(name) && SEMVER.test(version);
}

function validatePython(spec) {
  const parts = spec.split("==");
  return (
    parts.length === 2 &&
    PYTHON_NAME.test(parts[0]) &&
    PYTHON_VERSION.test(parts[1])
  );
}

export function authorizePackageRequest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["npm", "pypi"].includes(value.ecosystem) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > MAX_PACKAGES ||
    Object.keys(value).some(
      (key) => key !== "ecosystem" && key !== "packages",
    )
  ) {
    throw new Error("invalid package request");
  }

  const validate = value.ecosystem === "npm" ? validateNpm : validatePython;
  if (
    value.packages.some(
      (spec) => typeof spec !== "string" || !validate(spec),
    )
  ) {
    throw new Error("packages must use exact registry versions");
  }

  return {
    ecosystem: value.ecosystem,
    packages: [...new Set(value.packages)],
  };
}

export const packagePolicy = Object.freeze({
  maxPackages: MAX_PACKAGES,
  npm: "name@exact-semver",
  pypi: "name==exact-version",
});
