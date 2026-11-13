/**
 * A second process holding an UNCOMMITTED write grant on the coordinator's
 * store, for the opted-in pre-edit race test.
 *
 * The child opens its own ArtifactRegistry on the same state.db, registers
 * the path, and starts an ordinary acquire. Its instance's grant step is
 * wrapped: on the first call, inside the open BEGIN IMMEDIATE, it writes
 * `marker`, waits until `entered` exists (the server has started its own
 * decision), sleeps `graceMs`, and only then lets the transaction commit.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_URL = pathToFileURL(join(DIST, "registry.js")).href;
const AGENT_ID_URL = pathToFileURL(join(DIST, "agent_id.js")).href;

/** How long the child waits for `entered` before committing anyway. */
const ENTERED_WAIT_CAP_MS = 5000;

const HOLD_SCRIPT =
  "const [registryUrl, agentIdUrl, dbPath, path, sessionId, marker, entered, graceMs, capMs] = process.argv.slice(1);\n" +
  "const { existsSync, writeFileSync } = await import('node:fs');\n" +
  "const { ArtifactRegistry } = await import(registryUrl);\n" +
  "const { sessionToAgentId } = await import(agentIdUrl);\n" +
  "const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);\n" +
  "const reg = new ArtifactRegistry(dbPath);\n" +
  "const agentId = sessionToAgentId(sessionId);\n" +
  "const artifactId = reg.resolveOrRegisterArtifact(path, '');\n" +
  "const grant = reg.setAgentStateInternal;\n" +
  "let fired = false;\n" +
  "let sawEntered = false;\n" +
  "reg.setAgentStateInternal = function (...args) {\n" +
  "  const out = grant.apply(this, args);\n" +
  "  if (!fired) {\n" +
  "    fired = true;\n" +
  "    writeFileSync(marker, '');\n" +
  "    const deadline = Date.now() + Number(capMs);\n" +
  "    while (!existsSync(entered) && Date.now() < deadline) sleep(5);\n" +
  "    sawEntered = existsSync(entered);\n" +
  "    sleep(Number(graceMs));\n" +
  "  }\n" +
  "  return out;\n" +
  "};\n" +
  "reg.acquireExclusive(artifactId, agentId, Math.floor(Date.now() / 1000));\n" +
  "reg.close();\n" +
  "process.stdout.write(JSON.stringify({ agentId, fired, sawEntered }) + '\\n');\n";

export interface HolderReport {
  agentId: string;
  /** The wrapped grant step ran, so the marker was written inside the transaction. */
  fired: boolean;
  /** The server signalled `entered` before the child committed. */
  sawEntered: boolean;
}

export interface UncommittedHolder {
  child: ChildProcess;
  /** Resolves with the child's report once it has committed and exited. */
  report: Promise<HolderReport>;
}

/** Start a child that takes `path` for `sessionId` and holds the transaction open. */
export function holdUncommittedGrant(args: {
  dbPath: string;
  path: string;
  sessionId: string;
  marker: string;
  entered: string;
  graceMs: number;
}): UncommittedHolder {
  const argv = [
    REGISTRY_URL,
    AGENT_ID_URL,
    args.dbPath,
    args.path,
    args.sessionId,
    args.marker,
    args.entered,
    String(args.graceMs),
    String(ENTERED_WAIT_CAP_MS),
  ];
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLD_SCRIPT, ...argv], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const report = new Promise<HolderReport>((resolve, reject) => {
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`holder exited ${String(code)}: ${output.trim()}`));
      else resolve(JSON.parse(output.trim()) as HolderReport);
    });
  });
  return { child, report };
}
