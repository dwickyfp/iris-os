import deepmerge from "deepmerge";
import { getRequestConfig } from "next-intl/server";
import { safe } from "ts-safe";
import { getLocaleAction } from "./get-locale";

let defaultMessages: any = undefined;

export default getRequestConfig(async () => {
  const locale = await getLocaleAction();

  // Cache only in production so edited messages hot-reload in dev instead of
  // pinning the process to a stale snapshot (MISSING_MESSAGE for new keys).
  if (!defaultMessages || process.env.NODE_ENV !== "production") {
    defaultMessages = (await import(`../../messages/en.json`)).default;
  }

  const messages = await safe(() => import(`../../messages/${locale}.json`))
    .map((m) => m.default)
    .orElse(defaultMessages);

  return {
    locale,
    messages:
      locale === "en" ? defaultMessages : deepmerge(defaultMessages, messages),
    getMessageFallback({ key, namespace }) {
      return `${namespace}.${key}`;
    },
  };
});
