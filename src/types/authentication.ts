import { z } from "zod";
import { envBooleanSchema } from "./util";

export const AuthConfigSchema = z.object({
  emailAndPasswordEnabled: envBooleanSchema.default(true),
  signUpEnabled: envBooleanSchema.default(true),
});

export type AuthConfig = z.infer<typeof AuthConfigSchema>;
