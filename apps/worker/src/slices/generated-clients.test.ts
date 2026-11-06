import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeSlices } from "./analyze.js";
import { findGeneratedClientCalls, isGeneratedAxiosClient, parseGeneratedClient } from "./generated-clients.js";
import { write } from "./test-fixture.js";

/** The parts of an OpenAPI Generator typescript-axios client the reader relies on. */
const CLIENT = [
  "export class BaseAPI {}",
  "export const AuditApiAxiosParamCreator = function (configuration?: Configuration) {",
  "    return {",
  "        fetchAuditById: async (id: number, options: RawAxiosRequestConfig = {}): Promise<RequestArgs> => {",
  "            const localVarPath = `/audit/{id}`",
  "                .replace(`{${\"id\"}}`, encodeURIComponent(String(id)));",
  "            const localVarRequestOptions = { method: 'GET', ...baseOptions, ...options};",
  "        },",
  "        regenerateSnapshot: async (id: number, options: RawAxiosRequestConfig = {}): Promise<RequestArgs> => {",
  "            const localVarPath = `/audit/{id}/regenerate-snapshot`;",
  "            const localVarRequestOptions = { method: 'POST', ...baseOptions, ...options};",
  "        },",
  "    }",
  "};",
  "export class AuditApi extends BaseAPI {",
  "    public fetchAuditById(id: number) { return AuditApiFp(this.configuration).fetchAuditById(id); }",
  "    public regenerateSnapshot(id: number) { return AuditApiFp(this.configuration).regenerateSnapshot(id); }",
  "}",
  "export const RegistrationApiAxiosParamCreator = function (configuration?: Configuration) {",
  "    return {",
  "        getInvite: async (code: string, options: RawAxiosRequestConfig = {}): Promise<RequestArgs> => {",
  "            const localVarPath = `/registration/invite/{code}`;",
  "            const localVarRequestOptions = { method: 'GET', ...baseOptions, ...options};",
  "        },",
  "    }",
  "};",
  "export class RegistrationApi extends BaseAPI {",
  "    public getInvite(code: string) { return RegistrationApiFp(this.configuration).getInvite(code); }",
  "}"
].join("\n");

describe("generated typescript-axios clients", () => {
  it("reads each class's operations with their path and verb", () => {
    expect(isGeneratedAxiosClient(CLIENT)).toBe(true);
    expect(isGeneratedAxiosClient("export class Api extends BaseAPI {}")).toBe(false);
    const client = parseGeneratedClient("api.ts", CLIENT);
    expect(Object.fromEntries(Array.from(client.classes, ([name, methods]) => [name, Object.fromEntries(methods)]))).toEqual({
      AuditApi: {
        fetchAuditById: { method: "get", path: "/audit/{id}" },
        regenerateSnapshot: { method: "post", path: "/audit/{id}/regenerate-snapshot" }
      },
      RegistrationApi: { getInvite: { method: "get", path: "/registration/invite/{code}" } }
    });
  });

  it("finds calls on instances named after their class, inline instances, and other *Api receivers", () => {
    const client = parseGeneratedClient("api.ts", CLIENT);
    const text = [
      "const { auditApi } = useFieldApi();",
      "auditApi.fetchAuditById(1);",
      "api.auditApi.regenerateSnapshot(2);",
      "new RegistrationApi(config, base).getInvite(code);",
      "fieldApi.getInvite(code);",
      "someService.fetchAuditById(3);"
    ].join("\n");
    expect(findGeneratedClientCalls("hook.ts", text, [client]).map((call) => [call.operation, call.call.method, call.call.path, call.call.line])).toEqual([
      ["AuditApi.fetchAuditById", "get", "/audit/{}", 2],
      ["AuditApi.regenerateSnapshot", "post", "/audit/{}/regenerate-snapshot", 3],
      ["RegistrationApi.getInvite", "get", "/registration/invite/{}", 4],
      ["RegistrationApi.getInvite", "get", "/registration/invite/{}", 5]
    ]);
  });
});

describe("slices through a generated client", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "qa-buddy-generated-"));
    write(directory, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
    write(directory, "apps/field-api/package.json", JSON.stringify({ name: "@acme/field-api" }));
    write(
      directory,
      "apps/field-api/src/audit/audit.controller.ts",
      [
        "import { AuditService } from './audit.service';",
        "@Controller('audit')",
        "export class AuditController {",
        "  @Get(':id') fetchAuditById() {}",
        "  @Post(':id/regenerate-snapshot') regenerateSnapshot() {}",
        "}"
      ].join("\n")
    );
    write(directory, "apps/field-api/src/audit/audit.service.ts", "export class AuditService {}\n");
    write(directory, "apps/field-api/src/registration/registration.controller.ts", "@Controller('registration')\nexport class RegistrationController {\n  @Get('invite/:code') getInvite() {}\n}\n");

    write(directory, "apps/field/package.json", JSON.stringify({ name: "@acme/field" }));
    write(directory, "apps/field/index.html", `<script type="module" src="/src/main.ts"></script>`);
    write(directory, "apps/field/src/api/generated/api.ts", CLIENT);
    write(directory, "apps/field/src/api/generated/index.ts", "export * from './api';\n");
    write(
      directory,
      "apps/field/src/api/useFieldApi.ts",
      "import { AuditApi } from './generated';\nexport const useFieldApi = () => ({ auditApi: new AuditApi(config, import.meta.env.VITE_FIELD_API_HOST) });\n"
    );
    write(
      directory,
      "apps/field/src/main.ts",
      "import { useFieldApi } from './api/useFieldApi';\nconst { auditApi } = useFieldApi();\nauditApi.fetchAuditById(1);\n"
    );
    // Never imported, so its call does not count.
    write(directory, "apps/field/src/unused.ts", "import { useFieldApi } from './api/useFieldApi';\nuseFieldApi().auditApi.regenerateSnapshot(1);\n");
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("matches calls to the backend whose base URL the client is constructed with", async () => {
    const {
      slices: [field]
    } = await analyzeSlices(directory, [{ name: "field", frontendDirectory: "apps/field" }], [
      { directory: "apps/field-api", framework: "nestjs", baseUrlNames: ["VITE_FIELD_API_HOST"] }
    ]);
    expect(field!.endpoints.map((endpoint) => [endpoint.httpMethod, endpoint.path, endpoint.clientNames])).toEqual([
      ["get", "/audit/{id}", ["AuditApi.fetchAuditById"]]
    ]);
    expect(field!.backendFiles).toEqual(["apps/field-api/src/audit/audit.controller.ts", "apps/field-api/src/audit/audit.service.ts"]);
    expect(field!.unmatchedCalls).toEqual([]);
  });

  it("leaves the client's calls out when no configured backend's base URL constructs it", async () => {
    const {
      slices: [field]
    } = await analyzeSlices(directory, [{ name: "field", frontendDirectory: "apps/field" }], [
      { directory: "apps/field-api", framework: "nestjs", baseUrlNames: ["VITE_SOMETHING_ELSE"] }
    ]);
    expect(field!.endpoints).toEqual([]);
  });
});
