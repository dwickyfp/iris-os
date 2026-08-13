export const APP_TIME_ZONE = "Asia/Jakarta";

type DateValue = Date | string | number;

export function formatInAppTimeZone(
  value: DateValue,
  options: Intl.DateTimeFormatOptions,
  locale = "en-US",
) {
  return new Intl.DateTimeFormat(locale, {
    ...options,
    timeZone: APP_TIME_ZONE,
  }).format(new Date(value));
}

export function formatAppDate(value: DateValue) {
  return formatInAppTimeZone(value, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatAppDateTime(value: DateValue) {
  return formatInAppTimeZone(value, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
