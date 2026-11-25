import fs from "node:fs/promises";
import path from "node:path";
import type { DetectedProjectInfo } from "../types/index.js";
import { resolveGrammarForFile } from "./core.js";

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function stripJsonComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

async function detectJsTsConfig(
  repoRoot: string,
  frameworks: Set<string>,
  pathAliases: Record<string, string[]>
): Promise<void> {
  const pkgRaw = await readTextIfExists(path.join(repoRoot, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const jsFrameworkMap: Array<[string, string]> = [
        ["next", "Next.js"],
        ["nuxt", "Nuxt"],
        ["@nestjs/core", "NestJS"],
        ["express", "Express"],
        ["fastify", "Fastify"],
        ["koa", "Koa"],
        ["hono", "Hono"],
        ["react", "React"],
        ["vite", "Vite"],
        ["vue", "Vue"],
        ["@angular/core", "Angular"],
        ["svelte", "Svelte"],
        ["tailwindcss", "Tailwind CSS"],
        ["prisma", "Prisma"],
        ["typeorm", "TypeORM"],
        ["mongoose", "Mongoose"],
        ["@supabase/supabase-js", "Supabase"],
      ];
      for (const [dep, label] of jsFrameworkMap) {
        if (dep in allDeps) {
          frameworks.add(label);
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  for (const cfgName of ["tsconfig.json", "jsconfig.json"]) {
    const cfgRaw = await readTextIfExists(path.join(repoRoot, cfgName));
    if (!cfgRaw) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(cfgRaw)) as {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      const baseUrl = parsed.compilerOptions?.baseUrl ?? ".";
      const paths = parsed.compilerOptions?.paths;
      if (paths) {
        for (const [alias, targets] of Object.entries(paths)) {
          pathAliases[alias] = targets.map((t) =>
            path.posix.normalize(path.posix.join(baseUrl.replace(/\\/g, "/"), t.replace(/\\/g, "/")))
          );
        }
      }
      break;
    } catch {
      // Ignore malformed tsconfig
    }
  }
}

async function detectPythonFrameworks(
  repoRoot: string,
  frameworks: Set<string>
): Promise<void> {
  const pyFiles = [
    path.join(repoRoot, "requirements.txt"),
    path.join(repoRoot, "pyproject.toml"),
    path.join(repoRoot, "Pipfile"),
  ];
  const combined = (
    await Promise.all(pyFiles.map((f) => readTextIfExists(f)))
  )
    .filter((x): x is string => x !== null)
    .join("\n")
    .toLowerCase();

  if (!combined) return;
  const pyFrameworkMap: Array<[RegExp, string]> = [
    [/\bfastapi\b/, "FastAPI"],
    [/\bdjango\b/, "Django"],
    [/\bflask\b/, "Flask"],
    [/\bstreamlit\b/, "Streamlit"],
    [/\blangchain\b/, "LangChain"],
    [/\bpytorch|\btorch\b/, "PyTorch"],
    [/\bsqlalchemy\b/, "SQLAlchemy"],
    [/\bcelery\b/, "Celery"],
  ];
  for (const [re, label] of pyFrameworkMap) {
    if (re.test(combined)) frameworks.add(label);
  }
}

async function detectOtherFrameworks(
  repoRoot: string,
  frameworks: Set<string>
): Promise<void> {
  // .NET / C#
  try {
    const rootEntries = await fs.readdir(repoRoot);
    const csprojFiles = rootEntries.filter((f) => f.endsWith(".csproj"));
    for (const csproj of csprojFiles) {
      const content = await readTextIfExists(path.join(repoRoot, csproj));
      if (!content) continue;
      if (content.includes("Microsoft.NET.Sdk.Web")) frameworks.add("ASP.NET Core");
      if (content.includes("Microsoft.EntityFrameworkCore")) frameworks.add("Entity Framework Core");
      if (content.includes("UnityEngine")) frameworks.add("Unity");
    }
  } catch {
    // Ignore
  }

  // Java (Maven / Gradle)
  const pomRaw = await readTextIfExists(path.join(repoRoot, "pom.xml"));
  const gradleRaw =
    (await readTextIfExists(path.join(repoRoot, "build.gradle"))) ??
    (await readTextIfExists(path.join(repoRoot, "build.gradle.kts")));
  const javaManifest = `${pomRaw ?? ""}\n${gradleRaw ?? ""}`;
  if (javaManifest.includes("spring-boot")) frameworks.add("Spring Boot");
  if (javaManifest.includes("quarkus")) frameworks.add("Quarkus");

  // Go
  const goMod = await readTextIfExists(path.join(repoRoot, "go.mod"));
  if (goMod) {
    if (goMod.includes("github.com/gin-gonic/gin")) frameworks.add("Gin");
    if (goMod.includes("github.com/gofiber/fiber")) frameworks.add("Fiber");
    if (goMod.includes("github.com/labstack/echo")) frameworks.add("Echo");
  }

  // PHP
  const composer = await readTextIfExists(path.join(repoRoot, "composer.json"));
  if (composer) {
    if (composer.includes("laravel/framework")) frameworks.add("Laravel");
    if (composer.includes("symfony/")) frameworks.add("Symfony");
  }

  // Rust
  const cargo = await readTextIfExists(path.join(repoRoot, "Cargo.toml"));
  if (cargo) {
    if (cargo.includes("actix-web")) frameworks.add("Actix Web");
    if (cargo.includes("axum")) frameworks.add("Axum");
  }
}

export async function detectProjectInfo(
  repoRoot: string,
  scannedFiles: string[]
): Promise<DetectedProjectInfo> {
  const resolvedRoot = path.resolve(repoRoot);
  const languages: Record<string, number> = {};

  for (const filePath of scannedFiles) {
    try {
      const grammar = resolveGrammarForFile(filePath);
      const langKey = grammar === "tsx" ? "typescript" : grammar;
      languages[langKey] = (languages[langKey] ?? 0) + 1;
    } catch {
      // Unsupported file
    }
  }

  let primaryLanguage: string | null = null;
  let maxCount = 0;
  for (const [lang, count] of Object.entries(languages)) {
    if (count > maxCount) {
      maxCount = count;
      primaryLanguage = lang;
    }
  }

  const frameworks = new Set<string>();
  const pathAliases: Record<string, string[]> = {};

  // Check root and immediate subdirectories (monorepo support: e.g. Frontend/, Backend/, Scraper/)
  const dirsToInspect: string[] = [resolvedRoot];
  try {
    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "build"
      ) {
        dirsToInspect.push(path.join(resolvedRoot, entry.name));
      }
    }
  } catch {
    // Ignore
  }

  await Promise.all(
    dirsToInspect.flatMap((dir) => [
      detectJsTsConfig(dir, frameworks, pathAliases),
      detectPythonFrameworks(dir, frameworks),
      detectOtherFrameworks(dir, frameworks),
    ])
  );

  return {
    languages,
    primary_language: primaryLanguage,
    frameworks: Array.from(frameworks).sort(),
    path_aliases: pathAliases,
  };
}
