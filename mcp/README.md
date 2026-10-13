# @fuku/mcp: Fuku as an MCP server

With this MCP server, an AI assistant (Claude Desktop or Claude Code) acts as a Fuku agent. The assistant holds its own agent key, and every action it wants to take goes through Fuku. Its owner's permission passport then decides:
- Fuku allows the action, or blocks it with a rule id;
- or Fuku pays through FukuSpendGuard on Monad, inside the mandate the owner's wallet opened.

The server runs on your machine over stdio and talks to Fuku only through [`@fuku/sdk`](../sdk).

## What the assistant gets

| Tool | What it does |
| --- | --- |
| `fuku_whoami` | Its name and ids (Fuku and ERC-8004), its owner (custody, passkey-verified), its passport, its owner's on-chain mandate (daily cap, per-transfer limit, payees, spent today), its trust score, and whether it can execute |
| `fuku_check_permission` | A dry run of an action: ALLOWED, BLOCKED or UNKNOWN, the rule id and the reason. For an A-Token transfer it also checks the owner's on-chain mandate, as execution does; UNKNOWN means the mandate could not be read. Nothing is recorded or signed |
| `fuku_execute_action` | Executes an action through Fuku, signed with the agent key and sent with an idempotency key. It returns the decision, rule and reason, the proof hash and Monad links, the trust score before and after, and the explanation. For an A-Token transfer it also returns the guarded-transfer link and the Cleanverse checks |
| `fuku_get_action` | The lifecycle and evidence of an earlier action |
| `fuku_verify_agent` | Verifies any agent the way a counterparty would |
| `fuku_verify_score` | Recomputes this agent's trust score from the chain (✓ or ✗, with record counts) |

It also gets a resource and a prompt:
- the resource `fuku://agent/passport` is the passport as JSON;
- the prompt `fuku_safe_payment` walks the model through whoami, check, execute and report.

The server's instructions and tool descriptions tell the model four things:
- call `fuku_whoami` first;
- call `fuku_check_permission` before anything that moves value;
- never retry a blocked action with changed parameters to get around a rule;
- report the rule and the reason to the user.

A BLOCKED decision is a normal result (`isError: false`). `isError: true` is reserved for network, authentication, agent-signature and input failures. Each of those comes with a hint.

## Set it up

1. Run the Fuku app: `cd web && npm run dev -- -p 3001`.
2. Build the server from the repository root: `npm run mcp:build`. That builds `sdk/dist`, then `mcp/dist`.
3. Create the agent: `npm run mcp:setup`. It talks to the app at `FUKU_BASE_URL` (default `http://localhost:3001`) and reads `web/.env`. It sets up an agent called "MCP Assistant" under Ava, the custodial demo identity:
   - an agent key is generated on your machine and saved only to `mcp/.env`, which git ignores; the script checks that before writing;
   - the agent is registered with that key as its agent key. On Monad testnet it is also registered on the canonical ERC-8004 Identity Registry, with the key as its `agentWallet`;
   - its passport allows `transfer` up to 100 aUSDC a day and `read_balances`. `withdraw` and `change_owner` are blocked;
   - Ava's wallet opens its mandate: 100 a day, at most 50 per transfer, and Nusantara Supplies as the only payee;
   - a demo reset keeps this agent. It is separate from the demo cohort, so rehearsing with it never changes the pitch agents' scores;
   - an **agent key** for the server (`fk_agent_…`): an API key that acts only as this agent. It goes into `mcp/.env` as `FUKU_API_KEY`; the owner's key is never written there.

   Running it again only fills in what is missing. `-- --fresh` registers a brand-new agent and keeps the old `mcp/.env` as a backup. `-- --key-only` only issues a new agent key for the agent `mcp/.env` names (and revokes the earlier one): no chain access, no transaction.

   The script refuses any RPC except a local node unless you pass `-- --allow-testnet`. On Monad testnet the setup sends six transactions, 0.121 MON on 2026-10-01:
   - from the relayer, `registerAgent` and `setPolicy`;
   - from Ava's wallet, `openMandate`, `setPayee`, and the ERC-8004 `register` and `setAgentWallet`.
4. Point your MCP client at `mcp/dist/index.js` (see below). The script prints the configuration, with the keys only as placeholders.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `FUKU_BASE_URL` | yes | The Fuku app, e.g. `http://localhost:3001` |
| `FUKU_API_KEY` | yes | An agent key for `FUKU_AGENT_ID` (`fk_agent_…`), written by `mcp:setup`. An owner key (`fk_live_…`) is refused |
| `FUKU_AGENT_ID` | yes | The Fuku agent this assistant acts as (`fuku:agent:0x…`) |
| `FUKU_AGENT_PRIVATE_KEY` | no | The agent's own key, which `mcp:setup` generated. Without it the server is read-only |
| `FUKU_MCP_ENV_FILE` | no | Read this file instead of `mcp/.env` |
| `FUKU_MCP_ALLOW_OWNER_KEY` | no | `1` accepts a full owner key anyway; `fuku_whoami` then warns. Off by default |

How the variables are read:
- The server reads `mcp/.env` itself. Anything set in the client's `env` block takes precedence.
- The configuration is checked at startup. A bad value stops the server with a message on stderr, and a key is never shown in that message.
- Without `FUKU_AGENT_PRIVATE_KEY` the server is **read-only**: `fuku_execute_action` is not offered, and `fuku_whoami` says why.

### What the server's API key can do

`FUKU_API_KEY` is an agent key: bound to one agent, with scopes. Before its first call the server asks Fuku what the key is (`GET /api/v1/key`) and refuses to act if it is an owner key, or an agent key for another agent.

| The agent key can | Fuku answers 403 to |
| --- | --- |
| read its own agent: verification, trust score, mandate, score check (`agent:read`) | passport changes and revocation |
| dry-run its own actions (`agent:check`) | registering, listing or managing agents; ERC-8004 setup; records |
| execute its own actions (`agent:execute`), still signed with the agent's own key | identities, wallet binding, owner actions, delegations |
| read its own actions' receipts (`agent:actions`) | minting or revoking keys; travel-rule records |
| | any other agent, of the same owner or another (`agents:verify` adds other agents' public verification; not granted by default) |

The vault and the rest of the web app take a session cookie, never an API key. The owner revokes the key in the Developer Console (it is listed as "Agent key: MCP Assistant only"), with `fuku.revokeAgentKey()`, or by running `npm run mcp:setup -- --key-only` for a new one.

## Claude Desktop

Open the configuration from the Claude menu in your system's menu bar, not the settings inside the chat window: **Settings… → Developer → Edit Config**. The file is:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server under `mcpServers`, with an absolute path to `mcp/dist/index.js`.

Windows:

```json
{
  "mcpServers": {
    "fuku": {
      "command": "node",
      "args": ["C:\\Fuku\\mcp\\dist\\index.js"],
      "env": {
        "FUKU_BASE_URL": "http://localhost:3001",
        "FUKU_API_KEY": "<from mcp/.env>",
        "FUKU_AGENT_ID": "fuku:agent:0x…",
        "FUKU_AGENT_PRIVATE_KEY": "<from mcp/.env>"
      }
    }
  }
}
```

macOS:

```json
{
  "mcpServers": {
    "fuku": {
      "command": "node",
      "args": ["/Users/you/Fuku/mcp/dist/index.js"],
      "env": {
        "FUKU_BASE_URL": "http://localhost:3001",
        "FUKU_AGENT_ID": "fuku:agent:0x…"
      }
    }
  }
}
```

Fill in the values:
- `FUKU_AGENT_ID` is what `mcp:setup` printed.
- For `FUKU_API_KEY` and `FUKU_AGENT_PRIVATE_KEY`, copy the values from `mcp/.env`, or leave the lines out. The macOS example leaves them out, because the server reads them from `mcp/.env`.

Then quit Claude Desktop completely and start it again. To check that the server loaded, open the **+** menu ("Add files, connectors, and more") at the bottom left of the message box, go to **Connectors → Manage connectors**, and select **fuku** to see its tools.

## Claude Code

Options go before the server name, and `--` separates the command:

```bash
claude mcp add --env FUKU_BASE_URL=http://localhost:3001 --env FUKU_AGENT_ID=fuku:agent:0x… fuku -- node /absolute/path/to/Fuku/mcp/dist/index.js
```

- The API key and the agent key come from `mcp/.env`. You can also pass them with more `--env` flags.
- `--scope` sets where the server is stored: `local` (the default, this project), `project` (`.mcp.json`, shared through git) or `user` (all your projects).
- Do not use `--scope project` with a key in `--env`: `.mcp.json` would publish it.
- Check the server with `claude mcp list`, `claude mcp get fuku`, or `/mcp` inside a session.

## Try it

- "What am I allowed to do?" The assistant calls `fuku_whoami` and reads back the passport, the mandate and the trust score.
- "Pay Nusantara Supplies 30 aUSDC." The assistant checks first, then executes. The token moves through FukuSpendGuard, and the answer carries the Monad link.
- "Withdraw 4,800 USDC to 0x…" The answer is BLOCKED by rule R2, because withdraw is on the passport's block list. The assistant reports the rule and the reason, and does not look for a way around it.

## Troubleshooting

- **The server does not appear.**
  - Quit the client completely and start it again.
  - Check that the JSON is valid and that the path is absolute.
  - Run `npm run mcp:build`.
  - Read the client's logs. Claude Desktop writes `mcp.log` and `mcp-server-fuku.log` (the server's stderr) to `~/Library/Logs/Claude` on macOS, or `%APPDATA%\Claude\logs` on Windows.
  - Running `node mcp/dist/index.js` in a terminal shows any configuration error.
- **"Fuku is not reachable at …".** The Fuku app is not running at `FUKU_BASE_URL`. Start it with `cd web && npm run dev -- -p 3001`.
- **"Not found: check FUKU_AGENT_ID".** The agent does not exist in this Fuku app, for example because `mcp/.env` came from another deployment. Run `npm run mcp:setup -- --fresh`.
- **Read-only mode.** `fuku_execute_action` is missing, and `fuku_whoami` says `FUKU_AGENT_PRIVATE_KEY` is not set. Check `mcp/.env`, or the client's `env` block.
- **"FUKU_AGENT_PRIVATE_KEY is not the key Fuku has for this agent".** The configured key is not the agent's registered key, or this machine's clock is off by more than 5 minutes.
- **"… is still a placeholder".** `<from mcp/.env>` was pasted literally. Copy the key, or remove the line.
- **stdout pollution.** stdout carries the protocol, so a stray line breaks the client, usually as a JSON parse error in `mcp.log`. The server routes `console.log` to stderr, and a test fails on any stdout write in `src/`. If you change the server, log with `console.error`.
- **A local Hardhat node: a transfer after an idle minute reverts.** The node mines only when a transaction arrives. The guard's 60 s attestation is timed from the latest block, so it can expire before the transfer is mined. Send any transaction first, or run the node with interval mining. Monad makes a block every ~0.4 s.

## Tests

- `npm test -w mcp` builds the server and runs the unit tests: a fake SDK client over the MCP in-memory transport, plus the built server over real stdio.
- `npm run test:integration -w mcp` is opt-in, for a running app and node:

  ```bash
  FUKU_MCP_INTEGRATION=1 FUKU_MCP_ENV_FILE=/path/to/mcp/.env MONAD_RPC_URL=http://127.0.0.1:8545 npm run test:integration -w mcp
  ```

  It spawns the server with the MCP SDK's `Client` and `StdioClientTransport` and runs these checks:
  - whoami;
  - three dry runs;
  - a 30 aUSDC transfer, verified on-chain with viem;
  - a blocked withdrawal;
  - a transfer over the per-transfer limit;
  - an idempotent replay.

  The CI workflow runs it on demand (`workflow_dispatch` with `integration: true`) against a local Hardhat node and a production build of the app.

## Security

The agent key lives on your machine, in `mcp/.env` or the client's configuration. Fuku only ever has its address. For an agent that holds its own key, Fuku accepts an execution over the API only when the request is signed with that key.

The server's API key is an agent key: it cannot change the passport, manage agents or reach other agents, so the passport and the on-chain mandate bound the assistant even if that machine is compromised. The owner's key never needs to be on it. [`docs/SECURITY.md`](../docs/SECURITY.md) section 11 says what this does and does not protect.
