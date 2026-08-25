import { z } from "zod";

export const passwordRegexPattern =
  "^(?=.*[a-zA-Z])(?=.*\\d)[a-zA-Z\\d!@#$%^&*()_+\\-=\\[\\]{};':\"\\\\|,.<>\\/?]{8,20}$";

export const passwordRequirementsText =
  "Password must be 8-20 characters and contain at least one letter and one number.";

// Shared password validation schema
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long.")
  .max(20, "Password cannot exceed 20 characters.")
  .regex(new RegExp(passwordRegexPattern), passwordRequirementsText);
