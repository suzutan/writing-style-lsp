/**
 * LSP サーバー（stdio）。vscode-languageserver を transport に使い、
 * didOpen / didChange / didSave で lint して publishDiagnostics を push する。
 */
import { fileURLToPath } from "node:url";
import {
  createConnection,
  DiagnosticSeverity,
  type Diagnostic as LspDiagnostic,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { defaultRulesPath, Engine, type Severity } from "./engine";

const SEVERITY_MAP: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

function splitEnv(name: string): string[] {
  return (process.env[name] ?? "").split(name === "WSLSP_RULES" ? ":" : ",").filter((s) => s !== "");
}

const rulesPaths = splitEnv("WSLSP_RULES");
const engine = new Engine(
  rulesPaths.length > 0 ? rulesPaths : [defaultRulesPath()],
  splitEnv("WSLSP_ENABLE_CATEGORIES"),
  splitEnv("WSLSP_DISABLE_CATEGORIES"),
);

// Claude Code の LSP 起動は --stdio 引数を渡さないため、transport は stdio に固定する
const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let workspaceRoot: string | undefined;

function uriToPath(uri: string): string | undefined {
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

connection.onInitialize((params) => {
  const rootUri = params.rootUri ?? undefined;
  if (rootUri) workspaceRoot = uriToPath(rootUri);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
    serverInfo: { name: "wslsp", version: "0.2.0" },
  };
});

function validate(doc: TextDocument): void {
  const filePath = uriToPath(doc.uri);
  const diagnostics: LspDiagnostic[] = engine.lintText(doc.getText(), filePath, workspaceRoot).map((d) => ({
    range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) },
    severity: SEVERITY_MAP[d.severity],
    code: d.ruleId,
    source: "wslsp",
    message: d.message,
  }));
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((change) => validate(change.document));
documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
