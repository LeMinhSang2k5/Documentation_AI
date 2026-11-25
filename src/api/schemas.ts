import { z } from "zod";
import { parseSafeGithubRepoUrl } from "../utils/gitClient.js";

function isSafeRelativeFilePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.startsWith("\\")) {
    return false;
  }
  if (filePath.includes("\\") || filePath.includes("\0")) {
    return false;
  }
  const segments = filePath.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export const analyzeRequestSchema = z.object({
  repo_url: z
    .string({
      required_error: "repo_url is required",
      invalid_type_error: "repo_url must be a string",
    })
    .trim()
    .min(1, "repo_url cannot be empty")
    .refine((val) => parseSafeGithubRepoUrl(val) !== null, {
      message: "repo_url must be a valid HTTPS GitHub repository URL (https://github.com/<owner>/<repo>)",
    }),

  branch: z
    .string({ invalid_type_error: "branch must be a string" })
    .trim()
    .min(1, "branch cannot be empty")
    .max(200, "branch name is too long")
    .refine((val) => !val.includes("..") && !val.startsWith("-"), {
      message: "branch contains invalid characters",
    })
    .optional()
    .default("main"),

  commit_sha: z.preprocess(
    (val) => (val === "" ? null : val),
    z
      .union([
        z
          .string()
          .trim()
          .regex(/^[0-9a-fA-F]{6,40}$/, "commit_sha must be a 6-40 character hex SHA"),
        z.null(),
      ])
      .optional()
      .default(null)
  ),

  changed_files: z
    .array(
      z
        .string({ invalid_type_error: "changed_files items must be strings" })
        .trim()
        .refine(isSafeRelativeFilePath, {
          message: "Each changed_files item must be a relative path using '/' without leading '/' or '..'",
        })
    )
    .optional()
    .default([]),
});

export type ValidatedAnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
