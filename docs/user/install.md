# Install Kurambit

Kurambit runs coding agents on your computer and lets you make games with them from its desktop
app or the same interface in a browser. Linux x86_64 is the supported platform today; the games
it makes export to Windows, Linux and the web.

## Requirements

- Node.js 24 and [Vite+](https://viteplus.dev) (`vp`) to build from source.
- At least one installed, signed-in provider (see [Providers](#providers)). You can launch
  Kurambit first and configure providers afterwards.
- ffmpeg, installed yourself. Kurambit records each bot play with it, and a build's play facts
  (does it freeze, can it be won or lost) and **Keep going** are read from those recordings.
  Without it a build is only checked for booting. Install it with your package manager:
  `sudo apt install ffmpeg` (Debian, Ubuntu), `sudo dnf install ffmpeg` (Fedora, with RPM
  Fusion), `brew install ffmpeg` (macOS) or `winget install ffmpeg` (Windows), or get it from
  [ffmpeg.org/download](https://ffmpeg.org/download.html).
- For game art, Blender 4.2 or later, installed yourself. **Settings → General → Game tools**
  shows what Kurambit found, ffmpeg included, and links to each download. Games are three.js
  browser games and need nothing else installed.

## Run from source

```bash
git clone https://github.com/Absterrg0/Kurambit
cd Kurambit
vp i
vp run dev:desktop
```

`vp run dev` serves the same interface in your browser instead of opening the desktop app.

Packaged desktop builds will appear on
[GitHub Releases](https://github.com/Absterrg0/Kurambit/releases) as they are published.

### The `kurambit` command

The server ships a `kurambit` command line. Run `kurambit help` for the full reference. To open a
folder directly, pass a path such as `kurambit ./my-game`. If a server is already running for the
same data directory, connect to it instead of starting another, or pass a different `--base-dir`.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to the machine Kurambit runs on.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Kurambit's provider settings.                                                                                        |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |

Provider CLIs must be on the server's `PATH`. If Kurambit cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Kurambit warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when Kurambit cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with Kurambit. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Kurambit does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md), and
[Muse Code](./providers-muse.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
