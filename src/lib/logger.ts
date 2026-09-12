import { LogLevels, createConsola } from "consola";
import { IS_DEV } from "./const";

/**
 * Human-readable console output in development; one-JSON-object-per-line in
 * production so logs are shippable and greppable without a formatter.
 * Structured fields are attached via `logger.set`/consola `defaults`.
 */
const logger = createConsola({
  level: IS_DEV ? LogLevels.debug : LogLevels.info,
  defaults: {
    tag: "iris-os",
  },
  reporters: IS_DEV
    ? undefined
    : [
        {
          log(logObj) {
            const entry = {
              level: logObj.level,
              time: new Date(logObj.date).toISOString(),
              tag: logObj.tag,
              type: logObj.type,
              message: logObj.args?.[0] ?? logObj.message,
              ...(logObj.args?.[1] && typeof logObj.args[1] === "object"
                ? { context: logObj.args[1] }
                : {}),
              ...(logObj.extra ?? {}),
            };
            const serialized = JSON.stringify(entry);
            if (logObj.level >= 4) console.error(serialized);
            else console.log(serialized);
          },
        },
      ],
});

export default logger;
