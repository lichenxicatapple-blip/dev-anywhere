import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlErrorCode,
  RelayControlSchema,
  SessionState,
  type TerminalShell,
} from "@dev-anywhere/shared";
import { listTerminalShells, resolveTerminalShell } from "#src/common/terminal-shell.js";
import { tildify } from "#src/common/paths.js";
import { RelaySessionCreateHandler } from "#src/serve/relay-session-create-handler.js";
import { RelayResourceHandlers } from "#src/serve/relay-resource-handlers.js";
import type { SessionManager } from "#src/serve/session-manager.js";

vi.mock("#src/common/terminal-shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/common/terminal-shell.js")>()),
  listTerminalShells: vi.fn(),
  resolveTerminalShell: vi.fn(),
}));

function createHandler() {
  const relaySend = vi.fn();
  const start = vi.fn((_options: unknown) => ({ pid: 5678, abort: vi.fn() }));
  const createSession = vi.fn(
    (
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      cwd: string,
      pid: number,
      name: string,
      id: string,
      ptyOwner: "proxy-hosted",
      nameLocked: boolean,
    ) => ({
      id,
      kind,
      mode,
      provider,
      cwd,
      pid,
      name,
      ptyOwner,
      nameLocked,
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const env = { PATH: "shell-search-path" };
  const handler = new RelaySessionCreateHandler({
    relaySend,
    terminalWorkerSpawner: { start } as never,
    sessionManager: { createSession } as unknown as SessionManager,
    workerRegistry: {} as never,
    controlHandlers: {} as never,
    permissionBroker: {} as never,
    agentStatusRegistry: {} as never,
    getProviderEnv: () => env,
    createHookContext: vi.fn(),
    cleanupHookContext: vi.fn(),
    broadcastSessionSync: vi.fn(),
    broadcastSessionList: vi.fn(),
  });
  return { handler, relaySend, start, createSession, env };
}

const request = {
  type: "session_create",
  requestId: "create-shell",
  kind: "terminal",
  mode: "pty",
  cols: 80,
  rows: 24,
} as const;

beforeEach(() => vi.resetAllMocks());

describe("terminal session shell selection", () => {
  it.each([
    ["powershell", "D:\\PowerShell\\pwsh.exe", "PowerShell 7"],
    ["cmd", "D:\\Windows\\System32\\cmd.exe", "CMD"],
  ] as const)(
    "passes the selected %s executable to the worker and publishes its label",
    (shell, command, label) => {
      vi.mocked(resolveTerminalShell).mockReturnValue({ command, label });
      const { handler, relaySend, start, createSession, env } = createHandler();
      handler.onSessionCreate({ ...request, shell });
      expect(resolveTerminalShell).toHaveBeenCalledWith(shell, env);
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ shell: command, name: label }));
      expect(createSession).toHaveBeenCalledWith(
        "terminal",
        "pty",
        "claude",
        expect.any(String),
        5678,
        label,
        expect.any(String),
        "proxy-hosted",
        false,
        shell,
      );
      expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0]![0]))).toMatchObject({
        type: "session_create_response",
        requestId: "create-shell",
        success: true,
        kind: "terminal",
        name: label,
        nameLocked: false,
        shellFamily: shell,
      });
    },
  );

  it("uses the resolved default shell label for clients that omit a choice", () => {
    vi.mocked(resolveTerminalShell).mockReturnValue({
      command: "powershell.exe",
      label: "Windows PowerShell",
    });
    const { handler, start, env } = createHandler();
    handler.onSessionCreate(request);
    expect(resolveTerminalShell).toHaveBeenCalledWith(undefined, env);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: "Windows PowerShell" }));
  });

  it("retains an explicitly requested terminal name", () => {
    vi.mocked(resolveTerminalShell).mockReturnValue({ command: "cmd.exe", label: "CMD" });
    const { handler, relaySend, start } = createHandler();
    handler.onSessionCreate({ ...request, shell: "cmd", name: "  Build commands  " });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: "Build commands" }));
    expect(JSON.parse(relaySend.mock.calls[0]![0])).toMatchObject({
      name: "Build commands",
      nameLocked: true,
    });
  });

  it("keeps the existing working-directory name when the platform has no shell label", () => {
    vi.mocked(resolveTerminalShell).mockReturnValue({ command: "/bin/zsh" });
    const { handler, start } = createHandler();
    handler.onSessionCreate(request);
    const options = start.mock.calls[0]![0] as unknown as {
      cwd: string;
      name: string;
      shell: string;
    };
    expect(options.name).toBe(tildify(options.cwd));
    expect(options.shell).toBe("/bin/zsh");
  });

  it.each(["powershell", "cmd"] as TerminalShell[])(
    "returns a correlated failure without spawning when %s cannot resolve",
    (shell) => {
      vi.mocked(resolveTerminalShell).mockImplementation(() => {
        throw new Error("Selected shell is unavailable");
      });
      const { handler, relaySend, start, createSession } = createHandler();
      handler.onSessionCreate({ ...request, shell });
      expect(start).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0]![0]))).toMatchObject({
        type: "session_create_response",
        requestId: "create-shell",
        success: false,
        errorCode: ControlErrorCode.PROCESS_START_FAILED,
        error: "Selected shell is unavailable",
      });
    },
  );
});

describe("proxy terminal shell capabilities", () => {
  it.each(
    [
      undefined,
      [
        { id: "powershell", label: "Windows PowerShell" },
        { id: "cmd", label: "CMD" },
      ],
      [],
    ].map((shells) => ({ shells })),
  )(
    "propagates detected options without adding them to unsupported platforms ($shells)",
    async ({ shells }) => {
      vi.mocked(listTerminalShells).mockReturnValue(
        shells as ReturnType<typeof listTerminalShells>,
      );
      const relaySend = vi.fn();
      const env = { PATH: "" };
      const handler = new RelayResourceHandlers({
        relaySend,
        controlHandlers: {} as never,
        sessionManager: {} as never,
        getProviderEnv: () => env,
        getAgentCliSuggestions: () => ({}),
        setAgentCliPath: vi.fn(),
      });
      await handler.onProxyInfoRequest({
        type: "proxy_info_request",
        requestId: "shell-capabilities",
      });
      expect(listTerminalShells).toHaveBeenCalledWith(env);
      const message = RelayControlSchema.parse(JSON.parse(relaySend.mock.calls[0]![0]));
      if (shells === undefined) expect(message).not.toHaveProperty("terminalShells");
      else expect(message).toHaveProperty("terminalShells", shells);
    },
  );
});
