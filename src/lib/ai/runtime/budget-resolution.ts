import type { RunBudget } from "./budget";

export function narrowServerBudget(
  base: RunBudget,
  requested?: RunBudget,
): RunBudget {
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => {
      const candidate = requested?.[key as keyof RunBudget];
      return [
        key,
        candidate === undefined ? value : Math.min(value!, candidate),
      ];
    }),
  );
}
