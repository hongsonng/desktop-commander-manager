// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import * as api from "./api";

vi.mock("./api", () => ({
  getHealth: vi.fn(),
  getConnectionInfo: vi.fn(),
  getWorkers: vi.fn(),
  getResources: vi.fn(),
  getSessions: vi.fn(),
  getEvents: vi.fn(),
  getToolCalls: vi.fn(),
  workerAction: vi.fn(),
}));

const now = "2026-09-29T00:00:00.000Z";

afterEach(() => cleanup());

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  vi.mocked(api.getHealth).mockResolvedValue({
    status: "ok",
    startedAt: now,
    uptimeMs: 12345,
  });
  vi.mocked(api.getConnectionInfo).mockResolvedValue({
    mode: "direct-local",
    mcpUrl: "http://127.0.0.1:8787/mcp",
    workerStrategy: "sticky-failover",
  });
  vi.mocked(api.getWorkers).mockResolvedValue([
    {
      id: "worker-1",
      name: "Worker 1",
      enabled: true,
      status: "READY",
      pid: 101,
      failureCount: 0,
      lastHeartbeatAt: now,
      createdAt: now,
      updatedAt: now,
      activeSessionCount: 3,
    },
    {
      id: "worker-2",
      name: "Worker 2",
      enabled: false,
      status: "DISABLED",
      pid: null,
      failureCount: 1,
      lastHeartbeatAt: null,
      createdAt: now,
      updatedAt: now,
      activeSessionCount: 0,
    },
  ]);
  vi.mocked(api.getResources).mockResolvedValue({
    available: true,
    sampledAt: now,
    total: { memoryBytes: 180 * 1024 * 1024, cpuPercent: 2.4 },
    system: {
      memoryUsedBytes: 8 * 1024 ** 3,
      totalMemoryBytes: 32 * 1024 ** 3,
      cpuPercent: 18.5,
    },
    items: [
      {
        id: "manager",
        label: "Manager",
        pid: 100,
        memoryBytes: 32 * 1024 * 1024,
        cpuPercent: 0.5,
        processCount: 1,
        status: "running",
      },
      {
        id: "tunnel",
        label: "Secure MCP Tunnel",
        pid: 200,
        memoryBytes: 28 * 1024 * 1024,
        cpuPercent: 0.2,
        processCount: 3,
        status: "running",
      },
    ],
  });
  vi.mocked(api.getSessions).mockResolvedValue([
    {
      sessionId: "chat-a",
      workerId: "worker-1",
      createdAt: now,
      lastUsedAt: now,
    },
  ]);
  vi.mocked(api.getEvents).mockResolvedValue([
    {
      id: 1,
      sessionId: "chat-a",
      workerId: "worker-1",
      type: "SESSION_FAILOVER",
      message: "worker-2 -> worker-1",
      metadataJson: null,
      createdAt: now,
    },
  ]);
  vi.mocked(api.getToolCalls).mockResolvedValue([
    {
      id: 2,
      sessionId: "chat-a",
      workerId: "worker-1",
      toolName: "read_file",
      argsSummary: "path=D:/repo/file.txt",
      status: "OK",
      durationMs: 12,
      failedOver: false,
      createdAt: now,
    },
  ]);
  vi.mocked(api.workerAction).mockResolvedValue(undefined);
});

describe("dashboard", () => {
  it("shows a spinner while the dashboard is refreshing", async () => {
    let resolveHealth!: (
      value: Awaited<ReturnType<typeof api.getHealth>>,
    ) => void;
    vi.mocked(api.getHealth).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHealth = resolve;
      }),
    );

    render(<App />);

    const refreshingButton = screen.getByRole("button", {
      name: "Refreshing dashboard",
    });
    expect(refreshingButton).toBeDisabled();
    expect(refreshingButton).toHaveAttribute("aria-busy", "true");
    expect(
      refreshingButton.querySelector(".refresh-icon.is-spinning"),
    ).toBeTruthy();

    resolveHealth({ status: "ok", startedAt: now, uptimeMs: 12345 });
    await waitFor(() => {
      const refreshButton = screen.getByRole("button", {
        name: "Refresh dashboard",
      });
      expect(refreshButton).toBeEnabled();
      expect(
        refreshButton.querySelector(".refresh-icon.is-spinning"),
      ).toBeNull();
    });
  });

  it("renders the operations workspace and executes worker actions with refresh", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText("Desktop Commander Manager")).toBeTruthy();
    expect(await screen.findByText("Direct local")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:8787/mcp")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Worker 1" }),
    ).toBeTruthy();
    const workerCard = screen
      .getByRole("heading", { name: "Worker 1" })
      .closest("article")!;
    expect(within(workerCard).getByText("3")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Resource usage" }),
    ).toBeTruthy();
    expect(screen.getAllByText("180 MB")).toHaveLength(2);
    expect(screen.getAllByText(/Secure MCP Tunnel/).length).toBeGreaterThan(0);
    expect(screen.getByText("18.5%")).toBeTruthy();
    expect(screen.getByText("chat-a")).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Live activity" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "View details for read_file" }),
    ).toBeTruthy();
    expect(screen.getByText("path=D:/repo/file.txt")).toBeTruthy();
    expect(screen.getByText("12 ms")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: /Audit events/ }));
    expect(screen.getByText("SESSION_FAILOVER")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Restart Worker 1" }));
    await waitFor(() =>
      expect(api.workerAction).toHaveBeenCalledWith("worker-1", "restart"),
    );
    expect(vi.mocked(api.getWorkers).mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps successful data visible when one source fails", async () => {
    vi.mocked(api.getHealth).mockRejectedValueOnce(new Error("network down"));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "health: network down",
    );
    expect(
      await screen.findByRole("heading", { name: "Worker 1" }),
    ).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("PARTIAL");
  });

  it("filters activity, persists the view in the URL, and opens call details", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "View details for read_file" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(screen.getByText("No calls match these filters")).toBeTruthy();
    expect(window.location.search).toContain("kind=write");

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(
      screen.getByRole("button", { name: "View details for read_file" }),
    );
    const dialog = screen.getByRole("dialog", { name: "read_file" });
    expect(within(dialog).getByText("path=D:/repo/file.txt")).toBeTruthy();
    expect(within(dialog).getByText("12 ms")).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Close tool call details" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("labels recent activity as a snapshot sample and navigates between dashboard sections", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/?q=read#workers");
    vi.mocked(api.getToolCalls).mockResolvedValueOnce([{
      id: 22,
      sessionId: "chat-a",
      workerId: "worker-1",
      toolName: "read_file",
      argsSummary: "path=D:/repo/file.txt",
      status: "ERROR",
      durationMs: 48,
      failedOver: false,
      error: "read failed",
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    }]);
    render(<App />);
    expect(await screen.findByRole("img", {
      name: "1 tool call within the past hour in the latest 1-call snapshot, 1 error",
    })).toBeTruthy();
    expect(screen.getByText("RECENT TOOL CALL SAMPLE")).toBeTruthy();
    expect(screen.getByText("/ latest snapshot")).toBeTruthy();
    expect(screen.getByText("LATEST 1 CALL")).toBeTruthy();

    const navigation = screen.getByRole("navigation", {
      name: "Primary dashboard navigation",
    });
    const workerLink = within(navigation).getByRole("link", { name: "Workers" });
    expect(workerLink).toHaveClass("nav-current");

    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(window.location.hash).toBe("#workers");

    window.location.hash = "#resources";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => {
      expect(
        within(navigation).getByRole("link", { name: "Resources" }),
      ).toHaveClass("nav-current");
    });
  });

  it("exposes the dashboard shell as primary navigation with the active destination", async () => {
    render(<App />);

    const navigation = await screen.findByRole("navigation", {
      name: "Primary dashboard navigation",
    });
    const overviewLink = within(navigation).getByRole("link", {
      name: "Overview",
    });

    expect(overviewLink).toHaveAttribute("aria-current", "page");
    expect(
      within(navigation).getByRole("link", { name: "Live activity" }),
    ).toBeTruthy();
    expect(
      within(navigation).getByRole("link", { name: "Workers" }),
    ).toBeTruthy();
    expect(
      within(navigation).getByRole("link", { name: "Resources" }),
    ).toBeTruthy();
    expect(
      within(navigation).getByRole("link", { name: "Routing & audit" }),
    ).toBeTruthy();
  });

  it("does not report an empty worker pool when the workers request fails", async () => {
    vi.mocked(api.getWorkers).mockRejectedValueOnce(new Error("workers offline"));
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "workers: workers offline",
    );
    expect(screen.queryByText("No workers available")).toBeNull();
    expect(screen.getByText("Worker data unavailable")).toBeTruthy();
  });
});
