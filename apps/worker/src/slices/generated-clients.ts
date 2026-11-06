import ts from "typescript";
import { buildUrlCall, type UrlCall } from "./url-calls.js";

/**
 * Calls made through an OpenAPI Generator `typescript-axios` client that lives
 * inside the frontend (for example `src/hooks/riverside-api/generated/api.ts`).
 *
 * Such a client has one class per tag (`class AuditApi extends BaseAPI`) whose
 * methods are named after operation ids, and an `AuditApiAxiosParamCreator`
 * that spells out each method's path and verb. The path and verb are read from
 * there, so no operation ids need reproducing, and calls are matched to routes
 * like hand-written requests.
 */
export interface GeneratedClient {
  file: string;
  /** Class name → method name → request. */
  classes: Map<string, Map<string, { method: string; path: string }>>;
}

export interface GeneratedClientCall {
  client: GeneratedClient;
  call: UrlCall;
  /** `ClassName.method`, for display. */
  operation: string;
}

const PARAM = "\u0000";

/** Whether a module looks like a typescript-axios client. */
export function isGeneratedAxiosClient(text: string): boolean {
  return /extends\s+BaseAPI\b/.test(text) && text.includes("AxiosParamCreator");
}

/** Reads every API class's methods, with their path and verb, from a typescript-axios client. */
export function parseGeneratedClient(file: string, text: string): GeneratedClient {
  const classes = new Map<string, Map<string, { method: string; path: string }>>();
  const creators = Array.from(text.matchAll(/export const (\w+)AxiosParamCreator\s*=/g));
  creators.forEach((creator, index) => {
    const className = creator[1]!;
    const end = creators[index + 1]?.index ?? text.length;
    const block = text.slice(creator.index!, end);
    const methods = new Map<string, { method: string; path: string }>();
    // Each operation: `name: async (...) => { ... localVarPath = `/audits/{id}` ... method: 'GET' ...`
    const operations = Array.from(block.matchAll(/^\s*(\w+):\s*async\s*\(/gm));
    operations.forEach((operation, operationIndex) => {
      const body = block.slice(operation.index!, operations[operationIndex + 1]?.index ?? block.length);
      const pathMatch = /localVarPath\s*=\s*[`'"]([^`'"]+)[`'"]/.exec(body);
      const methodMatch = /\bmethod:\s*['"](\w+)['"]/.exec(body);
      if (pathMatch && methodMatch) methods.set(operation[1]!, { method: methodMatch[1]!.toLowerCase(), path: pathMatch[1]! });
    });
    if (methods.size) classes.set(className, methods);
  });
  return { file, classes };
}

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/**
 * Calls on client instances in one file: `auditApi.fetchAuditById(id)` when
 * the receiver is named after its class, `new RegistrationApi(config).getInvite()`,
 * or any receiver ending in `Api` whose method only one class defines.
 */
export function findGeneratedClientCalls(file: string, text: string, clients: GeneratedClient[]): GeneratedClientCall[] {
  const byInstanceName = new Map<string, { client: GeneratedClient; className: string }>();
  const byClassName = new Map<string, { client: GeneratedClient; className: string }>();
  const byMethod = new Map<string, Array<{ client: GeneratedClient; className: string }>>();
  for (const client of clients) {
    for (const [className, methods] of client.classes) {
      byInstanceName.set(lowerFirst(className), { client, className });
      byClassName.set(className, { client, className });
      for (const method of methods.keys()) {
        const list = byMethod.get(method) ?? [];
        list.push({ client, className });
        byMethod.set(method, list);
      }
    }
  }
  if (!Array.from(byMethod.keys()).some((method) => text.includes(method))) return [];

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.(?:[cm]?js|jsx|gjs)$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);
  const calls: GeneratedClientCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text;
      const candidates = byMethod.get(methodName);
      if (candidates) {
        const receiver = node.expression.expression;
        let owner: { client: GeneratedClient; className: string } | undefined;
        if (ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
          owner = byClassName.get(receiver.expression.text);
        } else {
          const receiverName = ts.isIdentifier(receiver) ? receiver.text : ts.isPropertyAccessExpression(receiver) ? receiver.name.text : null;
          if (receiverName) {
            owner = byInstanceName.get(receiverName);
            if (!owner && /api$/i.test(receiverName) && candidates.length === 1) owner = candidates[0];
          }
        }
        const request = owner?.client.classes.get(owner.className)?.get(methodName);
        if (owner && request) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const call = buildUrlCall(file, line, request.method, request.path.replace(/\{[^}]+\}/g, PARAM));
          if (call) calls.push({ client: owner.client, call, operation: `${owner.className}.${methodName}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** Files that construct one of a client's classes (`new AuditApi(config, baseUrl)`), where its base URL is chosen. */
export function constructsClient(text: string, client: GeneratedClient): boolean {
  return Array.from(client.classes.keys()).some((className) => new RegExp(`new\\s+${className}\\s*\\(`).test(text));
}
