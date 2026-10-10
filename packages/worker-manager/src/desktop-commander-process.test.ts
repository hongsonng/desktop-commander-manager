import { describe, expect, it } from "vitest";
import {
  desktopCommanderSpawnSpec,
  processTreeKillSpec,
} from "./desktop-commander-process";

describe("desktopCommanderSpawnSpec", () => {
  it("runs npx through cmd.exe on Windows instead of spawning npx.cmd directly", () => {
    expect(
      desktopCommanderSpawnSpec("win32", {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npx",
        "-y",
        "@wonderwhy-er/desktop-commander@latest",
        "--no-onboarding",
      ],
    });
    expect(
      desktopCommanderSpawnSpec("win32", { SystemRoot: "C:\\Windows" }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npx",
        "-y",
        "@wonderwhy-er/desktop-commander@latest",
        "--no-onboarding",
      ],
    });
  });

  it("kills the full worker process tree on Windows", () => {
    expect(
      processTreeKillSpec("win32", 4321, { SystemRoot: "C:\\Windows" }),
    ).toEqual({
      command: "C:\\Windows\\System32\\taskkill.exe",
      args: ["/PID", "4321", "/T", "/F"],
    });
    expect(processTreeKillSpec("linux", 4321, {})).toBeUndefined();
  });
  it("runs npx directly on non-Windows platforms", () => {
    expect(desktopCommanderSpawnSpec("linux", {})).toEqual({
      command: "npx",
      args: ["-y", "@wonderwhy-er/desktop-commander@latest", "--no-onboarding"],
    });
  });
});
