# Outside agents

Agents that Kurambit did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal and other local tools that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

The MCP server is the local server's address followed by `/mcp`, for example:

```text
http://localhost:3773/mcp
```

Use the port your Kurambit server listens on. Agents on the same computer can
reach it; agents hosted elsewhere, such as ChatGPT, cannot reach a local app.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent, and approval returns to a `localhost` address on the
computer that opened the page.

Only approve a sign-in you just started. To approve, enter a pairing code from
`kurambit auth pairing create`. A browser already signed in to the environment
with permission to manage access can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http kurambit http://localhost:3773/mcp
claude mcp login kurambit
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `kurambit` as connected
once you approve.

## Codex

```sh
codex mcp add kurambit --url http://localhost:3773/mcp
codex mcp login kurambit
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `kurambit` with OAuth once you approve.

## Other agents and bots

Any agent on this computer that supports MCP servers over HTTP with OAuth can
connect. Give it the MCP URL and choose OAuth, and the agent finds the sign-in
settings itself.
Agents without OAuth support cannot connect.

## Remove an agent

Approved agents are sessions like other clients. Run `kurambit auth session list`
to find one and `kurambit auth session revoke <id>` to cut off its access
immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
