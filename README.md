# Terminal Monitor

A compact VS Code extension for monitoring Codex tasks and integrated terminal commands.

## Features

- Automatically discovers VS Code integrated terminals.
- Monitors commands through VS Code Shell Integration events.
- Reads Codex thread and turn status from the local Codex App Server, including Codex tasks started in the VS Code sidebar.
- Shows Codex task titles, current status, workspace, current high-level step, and the latest final reply on hover.
- Keeps interface text in one Chinese copy file, colors task states by meaning, and shows five recent tasks before offering more.
- Lets you collapse the Codex, Active terminals, Idle terminals, and Recent groups.
- Click a Codex task to focus its matched terminal, including after the task finishes. Hover shows whether the match came from a manual choice, title and folder, a related CLI task, or recent terminal activity.
- Removes a Codex turn from the dashboard when its linked terminal closes; a later turn in that session appears again.
- Displays Active, Quiet, Idle, Completed, Failed, and Unknown states.
- Captures a small rolling window of recent command output.
- Shows compact hover cards: Codex status, current step, duration and update time come from the App Server; terminal cards show only the last three nonempty output lines or the command. Empty fields are hidden.
- Click a task to focus its original terminal.
- Reads the native VS Code terminal name. If you rename a terminal in VS Code, the sidebar reflects the new name automatically.
- Optional completion and failure notifications.
- Uses the current VS Code theme and keeps the UI compact.

## Important limitations

1. **Shell Integration is required for command-level monitoring.** If VS Code cannot activate Shell Integration for a terminal, the terminal is still listed, but commands and output may not be observable.
2. **Existing commands are not reconstructed.** When the extension first activates, commands that were already running before activation cannot reliably be recovered through the public VS Code API. Open terminals are listed as idle until a new command starts.
3. **Codex status requires the local Codex App Server daemon.** When its control socket is available, the extension reads thread and turn status from the local App Server. It makes read-only paginated `thread/list` and `thread/turns/list` requests; on hover, it reads up to ten items from the selected completed turn and only displays a public `final_answer`. The App Server connection opts into its `experimentalApi` capability only to defer command and tool output from that item request. It does not start, resume, steer, or interrupt Codex tasks. By default, it lists sessions in the open workspace; `terminalMonitor.codexScope` can include all sessions. With no open workspace, it defaults to all sessions and labels that scope in the dashboard. Unchanged recent sessions are cached; active session reads are limited to four concurrent requests. If the daemon is unavailable, retries back off to at most 60 seconds and return to the normal 3-second interval after recovery. Terminal monitoring remains available while Codex is disconnected.
4. **Terminal and Codex status mean different things.** For a Codex session, the Codex section uses the App Server's task status. For other terminal commands, Active means the command has not exited; Quiet means it has emitted no output for the configured interval. The default interval is 15 seconds.
5. **Terminal output is a stream, not a terminal screenshot.** Full-screen TUI redraws can appear as output activity, so a terminal command may remain Active while it is waiting for input. Codex App Server status is not inferred from terminal output.

The extension starts monitoring when VS Code finishes starting. If terminals still do not appear, run **Terminal Monitor: Refresh** and check **View → Output → Terminal Monitor** for the extension host and terminal counts.

## Extension host and Remote SSH

Terminal Monitor runs in the VS Code extension host for the open folder. In a local window, that is your computer; in a Remote SSH window, it is the remote machine. The Output channel reports `local` or the remote host name when monitoring starts, and reports whether the Codex App Server connection is available.

Codex status is read from a Unix socket on that same machine: `$CODEX_HOME/app-server-control/app-server-control.sock`, or `~/.codex/app-server-control/app-server-control.sock` when `CODEX_HOME` is unset. A local Codex socket is not forwarded automatically into a Remote SSH host. To monitor Codex in Remote SSH, Codex must provide its App Server socket on the remote machine. Terminal monitoring itself can still work while the Codex connection is unavailable.

The extension has been checked in local macOS VS Code. Remote SSH end-to-end, Windows, Linux desktop, and VS Code Insiders have not been validated; the VS Code engine version in `package.json` is a minimum API requirement, not a compatibility certification.

## Build and install

Clone the repository and build the extension:

```bash
git clone https://github.com/maotongf/terminal-monitor.git
cd terminal-monitor
npm ci
npm run compile
npm test
npx vsce package
```

Install the generated `.vsix` in VS Code using **Extensions → Install from VSIX...**, then click the Terminal Monitor icon in the Activity Bar. To install from a terminal, pass the generated file to:

```bash
code --install-extension terminal-monitor-1.12.0.vsix
```

For Remote SSH, install the extension in the remote extension host to monitor remote terminals. Codex status also requires the Codex App Server socket to be available on that remote host.

## Use

1. Open one or more VS Code integrated terminals.
2. Run commands normally, for example `codex`, `claude`, `python train.py`, `pytest`, or `bash test.sh`.
3. Open **Terminal Monitor** from the Activity Bar.
4. Click a task to focus its terminal.
5. Hover over a task to inspect its command, working directory, recent output, and timing. The details stay open as you move the pointer from the task into the details panel.
6. Rename terminals using VS Code's native terminal rename action. Terminal Monitor reads `terminal.name` and synchronizes the display automatically.

Codex tasks appear in the **Codex** section with their App Server status and current high-level step. Terminal tasks appear in the sections below. Click section headers to collapse or expand a whole group.

Click a Codex task to focus its matching terminal. Terminal Monitor remembers the match and its confidence, prefers a unique title and folder match, then uses related CLI task timing or recent terminal activity as a fallback. Hover shows the matching basis; right-click a task to choose its terminal manually. If no terminal is available, it opens one in the task folder or current workspace.

Manual associations are used while the chosen terminal remains open. Terminal Monitor shows five recent tasks by default; `terminalMonitor.historyLimit` controls how many completed terminal tasks it retains.

No special command wrapper is required.

## Settings

| Setting | Default | Description |
|---|---:|---|
| `terminalMonitor.quietThresholdSeconds` | `15` | Mark an active terminal command Quiet after this many seconds without output. |
| `terminalMonitor.completionNotifications` | `true` | Notify when a task lasting at least 30 seconds completes successfully. |
| `terminalMonitor.failureNotifications` | `true` | Notify when a task exits with a non-zero code. |
| `terminalMonitor.codexCompletionNotifications` | `true` | Notify when a Codex turn completes. |
| `terminalMonitor.codexFailureNotifications` | `true` | Notify when a Codex turn fails. |
| `terminalMonitor.codexApprovalNotifications` | `true` | Notify when a Codex task waits for approval. |
| `terminalMonitor.codexScope` | `workspace` | List Codex sessions in open workspace folders (`workspace`) or from all working directories (`all`). With no workspace, all sessions are shown. |
| `terminalMonitor.outputLineLimit` | `5` | Number of recent output lines retained per task. |
| `terminalMonitor.historyLimit` | `10` | Number of completed tasks retained in Recent. |

## Development

Requirements: Node.js 18+ and npm.

```bash
npm install
npm run compile
```

To debug:

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open multiple integrated terminals in the new window.
4. Run a mix of Agent and ordinary shell commands.
5. Open Terminal Monitor from the Activity Bar.

To package:

```bash
npm install
npx vsce package
```

This creates a `.vsix` file in the project root.

## Architecture

- `TerminalWatcher`: listens to VS Code terminal and Shell Integration events.
- `CodexMonitor`: polls the local Codex App Server for read-only thread and turn status.
- `TaskManager`: maintains terminal/task identity, state transitions, and recent history.
- `AgentDetector`: identifies common command types while preserving generic monitoring.
- `DashboardProvider`: renders the compact Webview sidebar and handles focus actions.
- `Notifier`: sends completion and failure notifications.

The extension does not start, stop, inject commands into, or take control of terminals. It does not upload terminal output or store task logs persistently.

## License

MIT. See `LICENSE`.

## Improvement plan

See the [phased fix and design plan](docs/FIX-PLAN.md) for status colors, priorities, acceptance criteria, and progress. The [1.2.6 review](docs/REVIEW-1.2.6.md) records the original findings.
