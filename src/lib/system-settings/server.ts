import "server-only";

import { pgSystemSettingsRepository } from "lib/db/pg/repositories/system-settings-repository.pg";
import { createSystemSettingsService } from "./service";

export const systemSettingsService = createSystemSettingsService(
  pgSystemSettingsRepository,
);
