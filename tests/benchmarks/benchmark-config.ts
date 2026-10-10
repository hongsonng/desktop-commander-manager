import { execSync } from "node:child_process";
import { cpus, totalmem, platform, release } from "node:os";

export interface BenchmarkEnvironment {
  os: string;
  osRelease: string;
  logicalCpus: number;
  totalMemoryBytes: number;
  nodeVersion: string;
  commitSha: string;
  timestamp: string;
}

export interface BenchmarkRunCounts {
  coldStarts: number;
  toolsList: number;
  toolsCall: number;
  workerRestarts: number;
  crashRecovery: number;
}

export function getBenchmarkEnvironment(): BenchmarkEnvironment {
  let commitSha = "unknown";
  try {
    commitSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {}

  return {
    os: platform(),
    osRelease: release(),
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    commitSha,
    timestamp: new Date().toISOString(),
  };
}

export function getBenchmarkCounts(isQuick = false): BenchmarkRunCounts {
  if (isQuick) {
    return {
      coldStarts: 5,
      toolsList: 50,
      toolsCall: 50,
      workerRestarts: 5,
      crashRecovery: 3,
    };
  }

  return {
    coldStarts: 50,
    toolsList: 500,
    toolsCall: 1000,
    workerRestarts: 100,
    crashRecovery: 20,
  };
}
