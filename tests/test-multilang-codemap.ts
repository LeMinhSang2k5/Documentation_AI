import assert from "node:assert/strict";
import {
  buildCodeMap,
  detectProjectInfo,
  groupFilesByBusinessFeature,
  parseSourceCode,
  scanRepositoryFiles,
} from "../src/parser/index.js";

async function testTypeScriptFeatures(): Promise<void> {
  const jwtFile = await parseSourceCode(
    `export function signToken(userId: string) {
  return "jwt_" + userId;
}`,
    "src/utils/jwt.ts"
  );

  const storeFile = await parseSourceCode(
    `export class UserStore {
  get(id: string) {
    return { id };
  }
  findByEmail(email: string) {
    return this.get(email);
  }
}`,
    "src/storage/userStore.ts"
  );

  const authFile = await parseSourceCode(
    `import { signToken as makeJwt } from "@/utils/jwt";
import { UserStore } from "../storage/userStore";

export function createAuthHandler(store: UserStore) {
  const cache = new Map<string, string>();

  const handleLogin = (email: string) => {
    const cached = cache.get(email);
    if (cached) return cached;
    store.findByEmail(email);
    return makeJwt(email);
  };

  return { handleLogin };
}`,
    "src/api/auth.ts"
  );

  const codeMap = buildCodeMap([jwtFile, storeFile, authFile], {
    pathAliases: { "@/*": ["src/*"] },
  });

  const handleLogin = codeMap.find((n) => n.name === "createAuthHandler.handleLogin");
  const signToken = codeMap.find((n) => n.name === "signToken");
  const userStoreGet = codeMap.find((n) => n.name === "UserStore.get");
  const userStoreFind = codeMap.find((n) => n.name === "UserStore.findByEmail");

  assert.ok(handleLogin, "Nested function createAuthHandler.handleLogin must be extracted");
  assert.ok(signToken, "signToken must be extracted");
  assert.ok(userStoreGet, "UserStore.get must be extracted");
  assert.ok(userStoreFind, "UserStore.findByEmail must be extracted");

  assert.ok(
    handleLogin.calls.includes(signToken.node_id),
    "Aliased import via @/ path alias must resolve to signToken"
  );
  assert.ok(
    handleLogin.calls.includes(userStoreFind.node_id),
    "handleLogin must call UserStore.findByEmail"
  );
  assert.ok(
    !handleLogin.calls.includes(userStoreGet.node_id),
    "Map.get() must NOT falsely link to UserStore.get"
  );
  assert.ok(
    userStoreFind.calls.includes(userStoreGet.node_id),
    "this.get() inside UserStore must resolve to UserStore.get"
  );

  console.log("[PASS] TypeScript: nested functions, import alias, @/ path alias, no Map.get false positive");
}

async function testPythonFastApi(): Promise<void> {
  const serviceFile = await parseSourceCode(
    `class AuthService:
    def verify_password(self, raw: str) -> bool:
        return len(raw) > 0

    def login(self, email: str, password: str) -> str:
        if self.verify_password(password):
            return "ok"
        return "fail"
`,
    "app/services/auth.py"
  );

  const routeFile = await parseSourceCode(
    `from app.services.auth import AuthService

@app.post("/login")
def login_endpoint(email: str, password: str):
    return AuthService.login(email, password)
`,
    "app/routes/auth_route.py"
  );

  const codeMap = buildCodeMap([serviceFile, routeFile]);
  const verifyFn = codeMap.find((n) => n.name === "AuthService.verify_password");
  const loginFn = codeMap.find((n) => n.name === "AuthService.login");
  const endpointFn = codeMap.find((n) => n.name === "login_endpoint");

  assert.ok(verifyFn && loginFn && endpointFn, "All Python functions/methods must be extracted");
  assert.ok(
    loginFn.calls.includes(verifyFn.node_id),
    "Python self.verify_password() must resolve to AuthService.verify_password"
  );
  assert.ok(
    endpointFn.calls.includes(loginFn.node_id),
    "Python cross-file import call AuthService.login must resolve"
  );

  console.log("[PASS] Python (FastAPI): decorated routes, self.* calls, cross-file module imports");
}

async function testCSharpAspNet(): Promise<void> {
  const serviceFile = await parseSourceCode(
    `namespace Demo.Services;

public class NewsService {
    public string CleanText(string raw) {
        return raw.Trim();
    }

    public string SummarizeArticle(string raw) {
        return this.CleanText(raw);
    }
}
`,
    "Services/NewsService.cs"
  );

  const controllerFile = await parseSourceCode(
    `using Demo.Services;

namespace Demo.Controllers {
    public class NewsController {
        public string PostSummary(string text) {
            return NewsService.SummarizeArticle(text);
        }
    }
}
`,
    "Controllers/NewsController.cs"
  );

  const codeMap = buildCodeMap([serviceFile, controllerFile]);
  const cleanFn = codeMap.find((n) => n.name === "NewsService.CleanText");
  const summarizeFn = codeMap.find((n) => n.name === "NewsService.SummarizeArticle");
  const controllerFn = codeMap.find((n) => n.name === "NewsController.PostSummary");

  assert.ok(cleanFn && summarizeFn && controllerFn, "All C# methods must be extracted");
  assert.ok(
    summarizeFn.calls.includes(cleanFn.node_id),
    "C# this.CleanText() must resolve to NewsService.CleanText"
  );
  assert.ok(
    controllerFn.calls.includes(summarizeFn.node_id),
    "C# cross-file NewsService.SummarizeArticle must resolve"
  );

  console.log("[PASS] C# (ASP.NET Core): namespaces, classes, methods, cross-file calls");
}

async function testGoGenericAdapter(): Promise<void> {
  const goFile = await parseSourceCode(
    `package main

import "fmt"

func HelperSum(a int, b int) int {
    return a + b
}

func MainHandler() {
    fmt.Println(HelperSum(1, 2))
}
`,
    "cmd/main.go"
  );

  const codeMap = buildCodeMap([goFile]);
  const helperFn = codeMap.find((n) => n.name === "HelperSum");
  const mainFn = codeMap.find((n) => n.name === "MainHandler");

  assert.ok(helperFn && mainFn, "Go functions must be extracted by generic adapter");
  assert.ok(mainFn.calls.includes(helperFn.node_id), "Go MainHandler must call HelperSum");

  console.log("[PASS] Go (Generic adapter): functions and calls extracted cleanly");
}

async function testProjectDetection(): Promise<void> {
  const files = await scanRepositoryFiles(process.cwd());
  const info = await detectProjectInfo(process.cwd(), files);

  assert.equal(info.primary_language, "typescript");
  assert.ok(info.frameworks.includes("Express"), "Must detect Express from package.json");

  console.log("[PASS] Project detector:", JSON.stringify(info));
}

async function testReactHooksAndApiObject(): Promise<void> {
  const clientFile = await parseSourceCode(
    `async function request(path, options) {
  return fetch(path, options);
}

export const api = {
  createTask: (payload) => request("/tasks", { method: "POST", body: payload }),
};
`,
    "src/api/client.js"
  );

  const hookFile = await parseSourceCode(
    `import { useCallback } from "react";
import { api } from "../api/client";

export function useTasks(options) {
  const addTask = useCallback(async (title) => {
    const created = await api.createTask({ title });
    return options.addToBottom ? created : created;
  }, [options.addToBottom]);

  return { addTask };
}
`,
    "src/hooks/useTasks.js"
  );

  const codeMap = buildCodeMap([clientFile, hookFile]);
  const requestFn = codeMap.find((n) => n.name === "request");
  const createTaskFn = codeMap.find((n) => n.name === "api.createTask");
  const addTaskFn = codeMap.find((n) => n.name === "useTasks.addTask");

  assert.ok(requestFn && createTaskFn && addTaskFn, "Must extract request, api.createTask, and useTasks.addTask");
  assert.ok(
    createTaskFn.calls.includes(requestFn.node_id),
    "api.createTask must resolve call to request"
  );
  assert.ok(
    addTaskFn.calls.includes(createTaskFn.node_id),
    "useTasks.addTask (wrapped in useCallback) must resolve cross-file call to api.createTask"
  );

  console.log("[PASS] React Hooks (useCallback) + exported API object methods cross-file call chain");
}

async function testFeatureGrouping(): Promise<void> {
  const mockFiles = [
    { file_path: "BE/controllers/AuthController.java", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "BE/services/AuthService.java", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "FE/src/context/AuthContext.jsx", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "FE/src/auth/LoginPage.jsx", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "BE/controllers/QuitPlanController.java", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "BE/services/QuitPlanService.java", has_syntax_error: false, imports: [], functions: [] },
    { file_path: "BE/dao/QuitPlanDAO.java", has_syntax_error: false, imports: [], functions: [] },
  ];

  const mockCodeMap = [
    {
      node_id: "fn_login_page",
      name: "LoginPage",
      file_path: "FE/src/auth/LoginPage.jsx",
      start_line: 1,
      end_line: 20,
      calls: ["fn_auth_ctx_login"],
    },
    {
      node_id: "fn_auth_ctx_login",
      name: "AuthContext.login",
      file_path: "FE/src/context/AuthContext.jsx",
      start_line: 1,
      end_line: 20,
      calls: [],
    },
  ];

  const grouped = groupFilesByBusinessFeature(mockFiles, mockCodeMap, () => "other");
  const authFiles = grouped.get("Feature: Auth")?.map((f) => f.file_path) ?? [];
  const quitPlanFiles = grouped.get("Feature: Quit Plan")?.map((f) => f.file_path) ?? [];

  assert.equal(authFiles.length, 4, "Feature: Auth must group AuthController, AuthService, AuthContext AND LoginPage (via Call Graph)");
  assert.ok(authFiles.includes("FE/src/auth/LoginPage.jsx"), "LoginPage must attach to Feature: Auth via call edge");
  assert.equal(quitPlanFiles.length, 3, "Feature: Quit Plan must group Controller + Service + DAO");

  console.log("[PASS] Feature grouping (Call Graph + Domain Stem): Auth (4 files), Quit Plan (3 files)");
}

async function main(): Promise<void> {
  await testTypeScriptFeatures();
  await testReactHooksAndApiObject();
  await testPythonFastApi();
  await testCSharpAspNet();
  await testGoGenericAdapter();
  await testFeatureGrouping();
  await testProjectDetection();
  console.log("\nALL MULTI-LANGUAGE CODE_MAP TESTS PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
