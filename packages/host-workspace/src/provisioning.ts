import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENV_SETUP_SCRIPT_NAME,
  DEFAULT_ENV_TEARDOWN_SCRIPT_NAME,
  WORKTREE_INCLUDE_FILE_NAME,
  createTerminalOutputLineReader,
  readTerminalOutputLines,
  type ProvisioningTranscriptEntry,
} from "@bb/domain";
import {
  killProcessGroup,
  sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess,
  supportsProcessGroups,
} from "@bb/process-utils";
import { Workspace } from "./workspace.js";
import { tryWithCheckoutMutationLock } from "./checkout-mutation-lock.js";
import {
  getGitCommonDir,
  pathExists,
  readDefaultBranch,
  readGitRepositoryState,
  runGit,
  WorkspaceError,
  type GitCommandResult,
} from "./git.js";
import {
  runGitWithWorktreeMetadataLock,
  withWorktreeMetadataLock,
} from "./worktree-metadata-lock.js";
import {
  copyWorktreeIncludeFiles,
  type CopyWorktreeIncludeFilesResult,
} from "./worktree-include.js";

type ProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
type EmitStepArgs = {
  onProgress: ProgressCallback | undefined;
  key: string;
  text: string;
  status: "started" | "completed" | "failed";
  startedAt?: number;
  metadata?: ProvisioningTranscriptEntry["metadata"];
};

interface CreateWorkspaceArgs {
  sourcePath: string;
  targetPath: string;
  branchName: string;
  baseBranch: string | null;
  timeoutMs: number;
  shellPath?: string;
  onProgress?: ProgressCallback;
  pruneEmptyParent?: boolean;
  signal?: AbortSignal;
}

interface RunWorkspaceHookArgs {
  workspacePath: string;
  timeoutMs: number;
  shellPath?: string;
  sourceCheckoutPath?: string;
  branchName?: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}

export interface RunSetupScriptArgs extends RunWorkspaceHookArgs {}

export interface RunTeardownScriptArgs extends RunWorkspaceHookArgs {}

export interface RemoveWorktreeArgs {
  path: string;
  /** Teardown script timeout in ms. Controlled by the server. */
  timeoutMs: number;
  force?: boolean;
  pruneEmptyParent?: boolean;
  shellPath?: string;
  onProgress?: ProgressCallback;
}

interface LifecycleScriptCommand {
  command: string;
  args: string[];
  text: string;
}

interface WorkspaceHookCommand extends LifecycleScriptCommand {
  source: "bb" | "paseo";
  displayName: string;
}

type WorkspaceHookPhase = "setup" | "teardown";

interface BuildLifecycleScriptCommandArgs {
  platform: NodeJS.Platform;
  scriptPath: string;
}

const SETUP_SCRIPT_ABORT_KILL_GRACE_MS = 2_000;
const PASEO_MANIFEST_FILE_NAME = "paseo.json";

function emitProgress(
  onProgress: ProgressCallback | undefined,
  entry: ProvisioningTranscriptEntry,
): void {
  onProgress?.(entry);
}

function emitStep(args: EmitStepArgs): void {
  emitProgress(args.onProgress, {
    type: "step",
    key: args.key,
    text: args.text,
    status: args.status,
    startedAt: args.startedAt ?? Date.now(),
    metadata: args.metadata,
  });
}

function emitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  text: string,
): void {
  emitProgress(onProgress, {
    type: "output",
    key,
    text,
    startedAt: Date.now(),
  });
}

function emitCwd(args: {
  onProgress: ProgressCallback | undefined;
  keySuffix: string;
  cwd: string;
}): void {
  emitStep({
    onProgress: args.onProgress,
    key: `workspace-${args.keySuffix}`,
    text: `Using workspace: ${args.cwd}`,
    status: "completed",
  });
}

function emitGitOutput(
  onProgress: ProgressCallback | undefined,
  key: string,
  result: GitCommandResult,
): void {
  const lines = readTerminalOutputLines(result.stdout + result.stderr);
  if (lines.length === 0) {
    return;
  }
  let index = 0;
  for (const line of lines) {
    index += 1;
    emitOutput(onProgress, `${key}-output-${index}`, line);
  }
}

async function ensureExistingWorkspaceMatches(
  targetPath: string,
  branchName: string,
  shellPath: string | undefined,
): Promise<boolean> {
  if (!(await pathExists(targetPath))) {
    return false;
  }

  const workspace = new Workspace(targetPath, {
    ...(shellPath !== undefined ? { shellPath } : {}),
  });
  if (!(await workspace.isGitRepo)) {
    throw new WorkspaceError(
      "path_exists",
      `Target path exists but is not a git repo: ${targetPath}`,
    );
  }

  if ((await workspace.currentBranch) !== branchName) {
    throw new WorkspaceError(
      "path_exists",
      `Target path exists on the wrong branch: ${targetPath}`,
    );
  }

  return true;
}

async function ensureWorkspaceParentDirectory(
  targetPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

function workspaceHookScriptName(phase: WorkspaceHookPhase): string {
  return phase === "setup"
    ? DEFAULT_ENV_SETUP_SCRIPT_NAME
    : DEFAULT_ENV_TEARDOWN_SCRIPT_NAME;
}

function workspaceHookFailureCode(phase: WorkspaceHookPhase): string {
  return phase === "setup" ? "setup_script_failed" : "teardown_script_failed";
}

function workspaceHookTitle(phase: WorkspaceHookPhase): string {
  return phase === "setup" ? "Setup" : "Teardown";
}

function parsePaseoHook(
  content: string,
  phase: WorkspaceHookPhase,
): string | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch (error) {
    throw new WorkspaceError(
      workspaceHookFailureCode(phase),
      `${PASEO_MANIFEST_FILE_NAME} is not valid JSON`,
      { cause: error },
    );
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new WorkspaceError(
      workspaceHookFailureCode(phase),
      `${PASEO_MANIFEST_FILE_NAME} must contain a JSON object`,
    );
  }
  const worktree = Reflect.get(manifest, "worktree");
  if (worktree === undefined) {
    return null;
  }
  if (
    typeof worktree !== "object" ||
    worktree === null ||
    Array.isArray(worktree)
  ) {
    throw new WorkspaceError(
      workspaceHookFailureCode(phase),
      `${PASEO_MANIFEST_FILE_NAME} worktree must contain a JSON object`,
    );
  }
  const hook = Reflect.get(worktree, phase);
  if (hook === undefined) {
    return null;
  }
  if (typeof hook !== "string" || hook.trim().length === 0) {
    throw new WorkspaceError(
      workspaceHookFailureCode(phase),
      `${PASEO_MANIFEST_FILE_NAME} worktree.${phase} must be a non-empty string`,
    );
  }
  return hook;
}

function buildPaseoHookCommand(
  phase: WorkspaceHookPhase,
  command: string,
): WorkspaceHookCommand {
  if (process.platform === "win32") {
    throw new WorkspaceError(
      workspaceHookFailureCode(phase),
      `POSIX shell workspace hooks are not supported on Windows: ${PASEO_MANIFEST_FILE_NAME} worktree.${phase}`,
    );
  }
  return {
    command: "env",
    args: ["bash", "-lc", command],
    text: `env bash -lc ${PASEO_MANIFEST_FILE_NAME} worktree.${phase}`,
    source: "paseo",
    displayName: `${PASEO_MANIFEST_FILE_NAME} worktree.${phase}`,
  };
}

async function resolveWorkspaceHookCommand(
  workspacePath: string,
  phase: WorkspaceHookPhase,
): Promise<WorkspaceHookCommand | null> {
  const scriptName = workspaceHookScriptName(phase);
  const scriptPath = path.join(workspacePath, scriptName);
  if (await pathExists(scriptPath)) {
    const command =
      phase === "setup"
        ? buildSetupScriptCommand({ platform: process.platform, scriptPath })
        : buildTeardownScriptCommand({
            platform: process.platform,
            scriptPath,
          });
    return {
      ...command,
      source: "bb",
      displayName: scriptName,
    };
  }

  const manifestPath = path.join(workspacePath, PASEO_MANIFEST_FILE_NAME);
  if (!(await pathExists(manifestPath))) {
    return null;
  }
  const hook = parsePaseoHook(await fs.readFile(manifestPath, "utf8"), phase);
  return hook === null ? null : buildPaseoHookCommand(phase, hook);
}

export function buildSetupScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    throw new WorkspaceError(
      "setup_script_failed",
      `POSIX shell setup scripts are not supported on Windows: ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
    );
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_SETUP_SCRIPT_NAME}`,
  };
}

function buildTeardownScriptCommand(
  args: BuildLifecycleScriptCommandArgs,
): LifecycleScriptCommand {
  if (args.platform === "win32") {
    throw new WorkspaceError(
      "teardown_script_failed",
      `POSIX shell teardown scripts are not supported on Windows: ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
    );
  }

  return {
    command: "env",
    args: ["bash", args.scriptPath],
    text: `env bash ${DEFAULT_ENV_TEARDOWN_SCRIPT_NAME}`,
  };
}

function createProvisionCancelledError(cause?: unknown): WorkspaceError {
  return new WorkspaceError(
    "provision_cancelled",
    "Workspace provisioning was cancelled",
    { cause },
  );
}

export function throwIfProvisionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createProvisionCancelledError(signal.reason);
  }
}

function isProvisionAbortError(error: unknown): boolean {
  return (
    error instanceof WorkspaceError && error.code === "provision_cancelled"
  );
}

async function resolveRemoteBaseBranch(
  sourcePath: string,
  baseBranch: string,
  shellPath: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ remote: string; branch: string } | null> {
  if (!baseBranch.includes("/")) {
    return null;
  }

  const remotes = (
    await runGit(["remote"], {
      cwd: sourcePath,
      signal,
      ...(shellPath !== undefined ? { shellPath } : {}),
    })
  ).stdout
    .split("\n")
    .map((remote) => remote.trim())
    .filter(Boolean);
  const matchingRemotes = remotes
    .filter(
      (remote) =>
        baseBranch.startsWith(`${remote}/`) &&
        baseBranch.length > remote.length + 1,
    )
    .sort((left, right) => right.length - left.length);
  const remote = matchingRemotes[0];
  if (!remote) {
    return null;
  }

  return {
    remote,
    branch: baseBranch.slice(remote.length + 1),
  };
}

async function fetchRemoteBaseBranch(args: {
  sourcePath: string;
  baseBranch: string;
  onProgress: ProgressCallback | undefined;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const remoteBase = await resolveRemoteBaseBranch(
    args.sourcePath,
    args.baseBranch,
    args.shellPath,
    args.signal,
  );
  if (!remoteBase) {
    return;
  }

  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-fetch-started",
    text: `Fetching ${args.baseBranch}`,
    status: "started",
    startedAt,
  });

  const refspec = `+refs/heads/${remoteBase.branch}:refs/remotes/${remoteBase.remote}/${remoteBase.branch}`;
  try {
    await runGit(["fetch", "--quiet", remoteBase.remote, refspec], {
      cwd: args.sourcePath,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      signal: args.signal,
    });
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-completed",
      text: `Fetched ${args.baseBranch}`,
      status: "completed",
      startedAt,
      metadata: {
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    emitStep({
      onProgress: args.onProgress,
      key: "git-fetch-failed",
      text: `Failed to fetch ${args.baseBranch}`,
      status: "failed",
      startedAt,
      metadata: {
        durationMs: Date.now() - startedAt,
      },
    });
    throw error;
  }
}

export async function createWorktree(
  args: CreateWorkspaceArgs,
): Promise<{ path: string }> {
  throwIfProvisionAborted(args.signal);
  if (
    await ensureExistingWorkspaceMatches(
      args.targetPath,
      args.branchName,
      args.shellPath,
    )
  ) {
    return { path: args.targetPath };
  }

  throwIfProvisionAborted(args.signal);
  switch (
    await readGitRepositoryState(args.sourcePath, {
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    })
  ) {
    case "not_git":
      throw new WorkspaceError(
        "not_git_repo",
        `Cannot create a worktree because the source is not a Git repository: ${args.sourcePath}. Initialize it and create at least one commit, then try again.`,
      );
    case "no_commits":
      throw new WorkspaceError(
        "unborn_head",
        `Cannot create a worktree because the repository has no commits: ${args.sourcePath}. Create an initial commit, then try again.`,
      );
    case "has_commits":
      break;
  }

  throwIfProvisionAborted(args.signal);
  await ensureWorkspaceParentDirectory(args.targetPath);

  throwIfProvisionAborted(args.signal);
  const baseBranch =
    args.baseBranch ??
    (await readDefaultBranch(args.sourcePath, {
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    }));
  if (!baseBranch) {
    throw new WorkspaceError(
      "missing_default_branch",
      `Cannot resolve default branch for source: ${args.sourcePath}`,
    );
  }
  throwIfProvisionAborted(args.signal);
  await fetchRemoteBaseBranch({
    sourcePath: args.sourcePath,
    baseBranch,
    onProgress: args.onProgress,
    shellPath: args.shellPath,
    signal: args.signal,
  });

  const gitArgs = [
    "worktree",
    "add",
    "-B",
    args.branchName,
    args.targetPath,
    baseBranch,
  ];
  const worktreeStartedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: "git-worktree-started",
    text: "Creating worktree",
    status: "started",
    startedAt: worktreeStartedAt,
  });
  let worktreeCreated = false;
  try {
    const result = await runGitWithWorktreeMetadataLock(gitArgs, {
      cwd: args.sourcePath,
      ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
      signal: args.signal,
    });
    emitGitOutput(args.onProgress, "git-worktree", result);
    emitStep({
      onProgress: args.onProgress,
      key: "git-worktree-completed",
      text: "Created worktree",
      status: "completed",
      startedAt: worktreeStartedAt,
      metadata: { durationMs: Date.now() - worktreeStartedAt },
    });
    worktreeCreated = true;
    emitCwd({
      onProgress: args.onProgress,
      keySuffix: "target",
      cwd: args.targetPath,
    });
    await copyIncludedFiles({
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      onProgress: args.onProgress,
      shellPath: args.shellPath,
      signal: args.signal,
    });
    await runSetupScript({
      workspacePath: args.targetPath,
      timeoutMs: args.timeoutMs,
      shellPath: args.shellPath,
      sourceCheckoutPath: args.sourcePath,
      branchName: args.branchName,
      onProgress: args.onProgress,
      signal: args.signal,
    });
    return { path: args.targetPath };
  } catch (error) {
    if (!worktreeCreated) {
      emitStep({
        onProgress: args.onProgress,
        key: "git-worktree-failed",
        text: "Worktree setup failed",
        status: "failed",
        startedAt: worktreeStartedAt,
        metadata: { durationMs: Date.now() - worktreeStartedAt },
      });
    }
    await removeWorktree({
      path: args.targetPath,
      timeoutMs: args.timeoutMs,
      force: true,
      pruneEmptyParent: args.pruneEmptyParent,
      shellPath: args.shellPath,
    });
    throw error;
  }
}

const WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT = 20;

function summarizePaths(paths: readonly string[]): string {
  const shown = paths.slice(0, WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT);
  const hiddenCount = paths.length - shown.length;
  const suffix = hiddenCount > 0 ? `, and ${hiddenCount} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

async function copyIncludedFiles(args: {
  sourcePath: string;
  targetPath: string;
  onProgress: ProgressCallback | undefined;
  shellPath: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<void> {
  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  let result: CopyWorktreeIncludeFilesResult;
  try {
    result = await copyWorktreeIncludeFiles({
      sourcePath: args.sourcePath,
      targetPath: args.targetPath,
      shellPath: args.shellPath,
      signal: args.signal,
    });
  } catch (error) {
    if (isProvisionAbortError(error)) {
      throw error;
    }
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${WORKTREE_INCLUDE_FILE_NAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  if (!result.ran) {
    return;
  }

  for (const skipped of result.skipped.slice(
    0,
    WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT,
  )) {
    emitOutput(args.onProgress, "worktree-include", `Skipped ${skipped}`);
  }
  const hiddenSkipCount =
    result.skipped.length - WORKTREE_INCLUDE_TRANSCRIPT_PATH_LIMIT;
  if (hiddenSkipCount > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Skipped ${hiddenSkipCount} more file(s)`,
    );
  }
  if (result.copied.length > 0) {
    emitOutput(
      args.onProgress,
      "worktree-include",
      `Copied ${result.copied.length} file(s): ${summarizePaths(
        result.copied,
      )}`,
    );
  }
  emitStep({
    onProgress: args.onProgress,
    key: "worktree-include-completed",
    text: `Copied ${result.copied.length} file(s) from ${WORKTREE_INCLUDE_FILE_NAME}`,
    status: "completed",
    startedAt,
    metadata: { durationMs: Date.now() - startedAt },
  });
}

async function resolvePaseoSourceCheckoutPath(
  workspacePath: string,
): Promise<string> {
  try {
    const commonGitDir = await getGitCommonDir(workspacePath);
    if (path.basename(commonGitDir) === ".git") {
      return path.dirname(commonGitDir);
    }
  } catch {
    // A standalone non-Git workspace has no source checkout.
  }
  return workspacePath;
}

async function resolvePaseoBranchName(workspacePath: string): Promise<string> {
  try {
    return (await new Workspace(workspacePath).currentBranch) ?? "";
  } catch {
    return "";
  }
}

async function runWorkspaceHook(
  phase: WorkspaceHookPhase,
  args: RunWorkspaceHookArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  throwIfProvisionAborted(args.signal);
  const command = await resolveWorkspaceHookCommand(args.workspacePath, phase);
  if (command === null) {
    return { ran: false };
  }

  throwIfProvisionAborted(args.signal);
  const startedAt = Date.now();
  emitStep({
    onProgress: args.onProgress,
    key: `${phase}-started`,
    text: `Running ${command.displayName}`,
    status: "started",
    startedAt,
  });

  const { timeoutMs } = args;
  const env = sanitizeInheritedChildProcessEnv({
    env: process.env,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
  });
  if (command.source === "paseo") {
    env.PASEO_SOURCE_CHECKOUT_PATH =
      args.sourceCheckoutPath ??
      (await resolvePaseoSourceCheckoutPath(args.workspacePath));
    env.PASEO_WORKTREE_PATH = args.workspacePath;
    env.PASEO_BRANCH_NAME =
      args.branchName ?? (await resolvePaseoBranchName(args.workspacePath));
  }
  const child = spawnPortableOutputProcess({
    command: command.command,
    args: command.args,
    cwd: args.workspacePath,
    detached: supportsProcessGroups(),
    env,
  });

  const outputChunks: string[] = [];
  const outputLineReader = createTerminalOutputLineReader();
  let outputIndex = 0;
  let abortKillTimeout: ReturnType<typeof setTimeout> | undefined;
  let abortRequested = false;
  let timedOut = false;

  const emitHookOutputLines = (lines: string[]): void => {
    for (const line of lines) {
      outputIndex += 1;
      emitOutput(args.onProgress, `${phase}-output-${outputIndex}`, line);
    }
  };

  const handleChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    outputChunks.push(text);
    emitHookOutputLines(outputLineReader.push(text));
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessGroup({
      child,
      signal: "SIGKILL",
    });
  }, timeoutMs);
  const abortHook = () => {
    if (abortRequested) {
      return;
    }
    abortRequested = true;
    killProcessGroup({
      child,
      signal: "SIGTERM",
    });
    abortKillTimeout = setTimeout(() => {
      killProcessGroup({
        child,
        signal: "SIGKILL",
      });
    }, SETUP_SCRIPT_ABORT_KILL_GRACE_MS);
  };
  args.signal?.addEventListener("abort", abortHook, { once: true });
  if (args.signal?.aborted) {
    abortHook();
  }

  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const output = outputChunks.join("");
    emitHookOutputLines(outputLineReader.flush());
    const durationMs = Date.now() - startedAt;
    if (phase === "setup" && (abortRequested || args.signal?.aborted)) {
      emitStep({
        onProgress: args.onProgress,
        key: `${phase}-cancelled`,
        text: `${command.displayName} cancelled`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw createProvisionCancelledError(args.signal?.reason);
    }

    if (timedOut) {
      emitStep({
        onProgress: args.onProgress,
        key: `${phase}-failed`,
        text: `${command.displayName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        workspaceHookFailureCode(phase),
        `${workspaceHookTitle(phase)} script timed out after ${timeoutMs}ms: ${command.displayName}`,
      );
    }

    if (result.signal) {
      emitStep({
        onProgress: args.onProgress,
        key: `${phase}-failed`,
        text: `${command.displayName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        workspaceHookFailureCode(phase),
        `${workspaceHookTitle(phase)} script exited via signal ${result.signal}: ${command.displayName}`,
      );
    }

    if ((result.exitCode ?? 0) !== 0) {
      emitStep({
        onProgress: args.onProgress,
        key: `${phase}-failed`,
        text: `${command.displayName} failed`,
        status: "failed",
        startedAt,
        metadata: { durationMs },
      });
      throw new WorkspaceError(
        workspaceHookFailureCode(phase),
        `${workspaceHookTitle(phase)} script failed with exit code ${result.exitCode}: ${command.displayName}`,
      );
    }

    emitStep({
      onProgress: args.onProgress,
      key: `${phase}-completed`,
      text: `${command.displayName} finished`,
      status: "completed",
      startedAt,
      metadata: { durationMs },
    });
    return { ran: true, exitCode: result.exitCode ?? 0, output };
  } finally {
    clearTimeout(timeout);
    clearTimeout(abortKillTimeout);
    args.signal?.removeEventListener("abort", abortHook);
  }
}

export function runSetupScript(
  args: RunSetupScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  return runWorkspaceHook("setup", args);
}

export function runTeardownScript(
  args: RunTeardownScriptArgs,
): Promise<{ ran: boolean; exitCode?: number; output?: string }> {
  return runWorkspaceHook("teardown", args);
}

export async function removeWorktree(args: RemoveWorktreeArgs): Promise<void> {
  const force = args.force !== false;
  const workspacePath = path.resolve(args.path);
  const parentPath = path.dirname(workspacePath);
  if (!(await pathExists(workspacePath))) {
    if (args.pruneEmptyParent) {
      await removeDirectoryIfEmpty(parentPath);
    }
    return;
  }

  await runTeardownScript({
    workspacePath,
    timeoutMs: args.timeoutMs,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    ...(args.onProgress !== undefined ? { onProgress: args.onProgress } : {}),
  });

  const commonDirResult = await runGit(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath,
    ...(args.shellPath !== undefined ? { shellPath: args.shellPath } : {}),
    allowFailure: true,
  });

  if (commonDirResult.exitCode === 0) {
    const commonDir = path.resolve(
      workspacePath,
      commonDirResult.stdout.trim(),
    );
    await tryWithCheckoutMutationLock(
      workspacePath,
      () =>
        withWorktreeMetadataLock(commonDir, () =>
          runGit(
            [
              "--git-dir",
              commonDir,
              "worktree",
              "remove",
              workspacePath,
              ...(force ? ["--force"] : []),
            ],
            {
              cwd: path.dirname(workspacePath),
              ...(args.shellPath !== undefined
                ? { shellPath: args.shellPath }
                : {}),
              allowFailure: true,
            },
          ),
        ),
      undefined,
      args.shellPath === undefined ? {} : { shellPath: args.shellPath },
    );
  }

  await fs.rm(workspacePath, { recursive: true, force: true });
  if (args.pruneEmptyParent) {
    await removeDirectoryIfEmpty(parentPath);
  }
}

async function removeDirectoryIfEmpty(pathToRemove: string): Promise<void> {
  try {
    await fs.rmdir(pathToRemove);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)
    ) {
      return;
    }

    throw error;
  }
}
