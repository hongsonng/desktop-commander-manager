import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { resolveDesktopCommanderSpawnSpec } from "./desktop-commander-package.js";

const DESKTOP_COMMANDER_ARGS = [
  "-y",
  "@wonderwhy-er/desktop-commander@latest",
  "--no-onboarding",
] as const;

export function desktopCommanderSpawnSpec(
  platform: NodeJS.Platform | string,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const systemRoot = env.SystemRoot ?? "C:\\Windows";
    const command =
      env.ComSpec ?? env.COMSPEC ?? join(systemRoot, "System32", "cmd.exe");
    return {
      command,
      args: ["/d", "/s", "/c", "npx", ...DESKTOP_COMMANDER_ARGS],
    };
  }
  return { command: "npx", args: [...DESKTOP_COMMANDER_ARGS] };
}
export function processTreeKillSpec(
  platform: NodeJS.Platform | string,
  pid: number,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } | undefined {
  if (platform !== "win32") return undefined;
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  return {
    command: join(systemRoot, "System32", "taskkill.exe"),
    args: ["/PID", String(pid), "/T", "/F"],
  };
}

async function killProcessTree(pid: number): Promise<boolean> {
  const spec = processTreeKillSpec(process.platform, pid, process.env);
  if (!spec) return false;
  await new Promise<void>((resolveKill) => {
    const killer = spawn(spec.command, spec.args, {
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolveKill();
      }
    };
    killer.once("error", done);
    killer.once("exit", done);
  });
  return true;
}
export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface WorkerProcessHandle {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<WorkerExit>;
  stop(): Promise<void>;
}

export interface DesktopCommanderProcessFactory {
  start(workerId: string, runtimeDir: string): Promise<WorkerProcessHandle>;
}

export function buildWorkerEnvironment(
  runtimeDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const root = resolve(runtimeDir);
  const home = resolve(join(root, "home"));
  const temp = resolve(join(root, "temp"));
  const psModuleAnalysisCache = resolve(
    join(temp, "Microsoft", "Windows", "PowerShell", "ModuleAnalysisCache"),
  );
  return {
    ...baseEnv,
    USERPROFILE: home,
    HOME: home,
    TEMP: temp,
    TMP: temp,
    PSModuleAnalysisCachePath: psModuleAnalysisCache,
  };
}

export function createDesktopCommanderProcessFactory(): DesktopCommanderProcessFactory {
  return {
    async start(_workerId, runtimeDir) {
      const root = resolve(runtimeDir);
      const logs = join(root, "logs");
      mkdirSync(join(root, "home"), { recursive: true });
      mkdirSync(join(root, "temp"), { recursive: true });
      mkdirSync(join(root, "temp", "Microsoft", "Windows", "PowerShell"), {
        recursive: true,
      });
      mkdirSync(logs, { recursive: true });

      const spawnSpec = resolveDesktopCommanderSpawnSpec(process.cwd());
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        env: buildWorkerEnvironment(root),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      if (!child.pid || !child.stdin || !child.stdout || !child.stderr)
        throw new Error("Failed to start Desktop Commander worker");

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdoutLog = join(logs, "stdout.log");
      const stderrLog = join(logs, "stderr.log");
      child.stdout.on("data", (chunk) => {
        appendFileSync(stdoutLog, chunk);
        stdout.write(chunk);
      });
      child.stdout.on("end", () => stdout.end());
      child.stderr.on("data", (chunk) => {
        appendFileSync(stderrLog, chunk);
        stderr.write(chunk);
      });
      child.stderr.on("end", () => stderr.end());

      const exited = new Promise<WorkerExit>((resolveExit) => {
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
        child.once("error", () => resolveExit({ code: 1, signal: null }));
      });

      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout,
        stderr,
        exited,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const killedTree = await killProcessTree(child.pid!);
          if (!killedTree) child.kill();
          await Promise.race([
            exited,
            new Promise((resolveWait) => setTimeout(resolveWait, 2000)),
          ]);
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        },
      };
    },
  };
}
