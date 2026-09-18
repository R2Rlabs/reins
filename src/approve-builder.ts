import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { isAddress } from "viem";
import {
  APPROVE_BUILDER_FEE_PRIMARY_TYPE,
  APPROVE_BUILDER_FEE_TYPES,
  checkSignedApproval,
  maxFeeRate,
  USER_SIGNED_DOMAIN_NAME,
  type ApprovalRequest,
} from "./builder-approval.js";
import { MAX_PERP_BUILDER_FEE_TENTHS_BPS } from "./client.js";
import { DEFAULT_BUILDER_FEE_TENTHS_BPS, REINS_BUILDER_ADDRESS } from "./init.js";
import type { Network } from "./types.js";

/**
 * `reins approve-builder` — lets a user approve Reins' builder fee with the
 * wallet they already use, without the key ever reaching Reins.
 *
 * The approval has to be signed by the user's *main* wallet: the one holding
 * their funds. A command that asked for that key would be teaching people to
 * paste it into terminals. Instead this serves a page on 127.0.0.1, the
 * browser wallet signs there, and only the signature comes back — which is
 * checked, sent to Hyperliquid, and then confirmed by reading the approval
 * back.
 */

export const APPROVE_USAGE = `Usage: reins approve-builder [options]

Approves Reins' builder fee for your Hyperliquid account, once. Opens a page
in your browser where your wallet (MetaMask or similar) signs the approval.
Your private key never leaves the wallet, and signing costs no gas.

Sign with your main wallet — the one holding your Hyperliquid funds, not an
API wallet.

Options:
  --max-fee <bp>       Highest fee to approve, basis points        (default 2)
  --network <name>     mainnet or testnet                    (default mainnet)
  --check <address>    Show what this wallet has approved, and exit
  --no-open            Print the page's address instead of opening it
  -h, --help           Show this help
`;

export interface ApproveOptions {
  maxFeeTenthsBps: number;
  network: Network;
  check: string | undefined;
  open: boolean;
  help: boolean;
}

export function parseApproveArgs(argv: string[]): ApproveOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "max-fee": { type: "string", default: String(DEFAULT_BUILDER_FEE_TENTHS_BPS / 10) },
      network: { type: "string", default: "mainnet" },
      check: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const bp = Number(values["max-fee"]);
  const tenths = Math.round(bp * 10);
  if (!Number.isFinite(bp) || bp <= 0 || Math.abs(bp * 10 - tenths) > 1e-9) {
    throw new Error(`--max-fee must be a positive number of basis points in 0.1 steps, got "${values["max-fee"]}".`);
  }
  if (tenths > MAX_PERP_BUILDER_FEE_TENTHS_BPS) {
    throw new Error(`--max-fee can be at most ${MAX_PERP_BUILDER_FEE_TENTHS_BPS / 10} bp, Hyperliquid's cap on perps.`);
  }
  const network = values.network;
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`--network must be "mainnet" or "testnet", got "${network}".`);
  }
  if (values.check !== undefined && !isAddress(values.check, { strict: false })) {
    throw new Error(`--check needs a wallet address, got "${values.check}".`);
  }
  return {
    maxFeeTenthsBps: tenths,
    network,
    check: values.check,
    open: !values["no-open"],
    help: values.help,
  };
}

/** The two exchange calls this command makes, so tests can stand in for them. */
export interface ApprovalClient {
  submitBuilderApproval(request: ApprovalRequest): Promise<{ ok: true } | { ok: false; message: string }>;
  maxBuilderFee(user: string, builder: string): Promise<number>;
}

export interface ApproveDeps {
  clientFor(network: Network): ApprovalClient;
  out(text: string): void;
  openBrowser(url: string): void;
  now(): number;
  builderAddress?: string;
  /** How long to wait for a signature before giving up. */
  timeoutMs?: number;
}

const bp = (tenths: number) => `${tenths / 10} bp (${maxFeeRate(tenths)})`;

export async function runApproveBuilder(argv: string[], deps: ApproveDeps): Promise<void> {
  const opts = parseApproveArgs(argv);
  if (opts.help) {
    deps.out(APPROVE_USAGE);
    return;
  }
  const builder = deps.builderAddress ?? REINS_BUILDER_ADDRESS;
  if (builder === "") {
    throw new Error("This build of Reins has no builder address, so there is nothing to approve.");
  }
  const client = deps.clientFor(opts.network);

  if (opts.check) {
    const approved = await client.maxBuilderFee(opts.check, builder);
    deps.out(
      approved > 0
        ? `${opts.check} has approved Reins for up to ${bp(approved)} on ${opts.network}.\n` +
            `Reins charges ${bp(DEFAULT_BUILDER_FEE_TENTHS_BPS)} by default.\n`
        : `${opts.check} has not approved Reins' builder fee on ${opts.network}.\n`,
    );
    return;
  }

  const session = await startApprovalServer(
    { builder, maxFeeTenthsBps: opts.maxFeeTenthsBps, network: opts.network },
    { client, now: deps.now, timeoutMs: deps.timeoutMs ?? 15 * 60_000 },
  );
  deps.out(
    `Approve Reins' builder fee of up to ${bp(opts.maxFeeTenthsBps)} on ${opts.network}.\n` +
      `Sign in your browser with your main wallet:\n  ${session.url}\n` +
      `Waiting for the signature… (Ctrl+C to cancel)\n`,
  );
  if (opts.open) deps.openBrowser(session.url);

  const result = await session.done;
  deps.out(
    result.ok
      ? `✓ Approved: ${result.user} allows Reins up to ${bp(result.approvedTenthsBps)} on ${opts.network}.\n`
      : `✗ Not approved: ${result.message}\n`,
  );
  if (!result.ok) throw new ApprovalFailedError(result.message);
}

export class ApprovalFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalFailedError";
  }
}

export type ApprovalResult =
  | { ok: true; user: string; approvedTenthsBps: number }
  | { ok: false; message: string };

export interface ApprovalSession {
  url: string;
  /** Settles once: approved, refused by Hyperliquid, or timed out. */
  done: Promise<ApprovalResult>;
  close(): void;
}

/**
 * The local page and the one endpoint it posts to. Bound to 127.0.0.1 behind
 * a random path, and it checks the Host header, so neither another machine
 * nor a web page using DNS rebinding can drive it. A bad submission — wrong
 * builder, wrong rate, a signature from someone else — is refused and the
 * page can try again; the session ends only when Hyperliquid answers.
 */
export async function startApprovalServer(
  params: { builder: string; maxFeeTenthsBps: number; network: Network },
  deps: { client: ApprovalClient; now(): number; timeoutMs: number },
): Promise<ApprovalSession> {
  const token = randomBytes(16).toString("hex");
  const rate = maxFeeRate(params.maxFeeTenthsBps);
  let settle!: (result: ApprovalResult) => void;
  const done = new Promise<ApprovalResult>((resolve) => {
    settle = resolve;
  });
  let host = "";

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      send(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.host !== host) return send(res, 403, { ok: false, message: "Wrong host." });
    if (req.method === "GET" && req.url === `/${token}`) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      res.end(approvalPage({ ...params, maxFeeRate: rate }));
      return;
    }
    if (req.method === "POST" && req.url === `/${token}/submit`) {
      const body = JSON.parse(await readBody(req)) as { action?: unknown; signature?: unknown; user?: unknown };
      let checked;
      try {
        checked = await checkSignedApproval(
          { builder: params.builder, maxFeeRate: rate, network: params.network, now: deps.now() },
          { action: body.action, signature: body.signature, user: body.user },
        );
      } catch (error) {
        return send(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
      }

      const submitted = await deps.client.submitBuilderApproval(checked.request);
      if (!submitted.ok) {
        send(res, 200, { ok: false, message: `Hyperliquid refused it: ${submitted.message}` });
        finish({ ok: false, message: `Hyperliquid refused it: ${submitted.message}` });
        return;
      }
      // Read it back rather than trusting "ok": this is what orders will be checked against.
      const approved = await deps.client.maxBuilderFee(checked.user, params.builder);
      send(res, 200, { ok: true, user: checked.user, approvedTenthsBps: approved });
      finish({ ok: true, user: checked.user, approvedTenthsBps: approved });
      return;
    }
    send(res, 404, { ok: false, message: "Not found." });
  }

  const timer = setTimeout(
    () => finish({ ok: false, message: "No signature arrived in time. Run the command again." }),
    deps.timeoutMs,
  );
  function finish(result: ApprovalResult): void {
    clearTimeout(timer);
    settle(result);
    // Let the page's response go out, then drop the browser's keep-alive
    // connections too, or close() would wait on them and the command hang.
    setImmediate(() => {
      server.close();
      server.closeAllConnections();
    });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  return {
    url: `http://${host}/${token}`,
    done,
    close: () => finish({ ok: false, message: "Cancelled." }),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new Error("Request too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The signing page. Self-contained: no scripts or styles from anywhere else,
 * and the content security policy above forbids them, so nothing but this
 * page and the wallet sees the request. The typed-data definition is the same
 * object the server verifies against, serialised in.
 */
export function approvalPage(params: {
  builder: string;
  maxFeeTenthsBps: number;
  maxFeeRate: string;
  network: Network;
}): string {
  const config = {
    builder: params.builder.toLowerCase(),
    maxFeeRate: params.maxFeeRate,
    hyperliquidChain: params.network === "mainnet" ? "Mainnet" : "Testnet",
    domainName: USER_SIGNED_DOMAIN_NAME,
    types: APPROVE_BUILDER_FEE_TYPES,
    primaryType: APPROVE_BUILDER_FEE_PRIMARY_TYPE,
  };
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const feeBp = params.maxFeeTenthsBps / 10;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve Reins builder fee</title>
<style>
:root { color-scheme: light dark; --bg: #f7f8fa; --card: #fff; --text: #111827; --muted: #5b6474; --line: #e3e6eb; --accent: #15803d; --bad: #b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c0f16; --card: #141a24; --text: #e8edf4; --muted: #8b96a8; --line: #242d3b; --accent: #4ade80; --bad: #f87171; } }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, sans-serif; }
main { max-width: 560px; margin: 48px auto; padding: 0 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
h1 { font-size: 22px; margin: 0 0 12px; }
p { margin: 0 0 14px; color: var(--muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 18px 0 22px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.addr { font-family: ui-monospace, monospace; word-break: break-all; }
button { font: inherit; font-weight: 600; padding: 12px 20px; border-radius: 10px; border: 0; background: var(--accent); color: #06210f; cursor: pointer; min-height: 44px; }
button:disabled { opacity: .5; cursor: default; }
#status { margin-top: 16px; min-height: 1.6em; }
.ok { color: var(--accent); } .bad { color: var(--bad); }
</style>
</head>
<body>
<main>
<div class="card">
<h1>Approve the Reins builder fee</h1>
<p>Reins adds a small fee to live orders your agents place through it on Hyperliquid. Before any order can carry it, you approve the maximum once, here.</p>
<dl>
<dt>Maximum fee</dt><dd>${feeBp} bp (${params.maxFeeRate}) of each order's value</dd>
<dt>Paid to</dt><dd class="addr">${params.builder}</dd>
<dt>Network</dt><dd>Hyperliquid ${params.network}</dd>
</dl>
<p><strong>Sign with your main wallet</strong> — the one holding your Hyperliquid funds, not an API wallet. Signing costs no gas and moves no money. Your key stays in your wallet; this page only receives the signature.</p>
<button id="approve">Connect wallet and approve</button>
<div id="status" role="status"></div>
</div>
</main>
<script>
const C = ${json};
const status = document.getElementById("status");
const button = document.getElementById("approve");
function say(text, cls) { status.textContent = text; status.className = cls || ""; }
button.addEventListener("click", async () => {
  if (!window.ethereum) { say("No browser wallet found. Open this page in a browser with MetaMask or another wallet installed.", "bad"); return; }
  button.disabled = true;
  try {
    const [user] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    const nonce = Date.now();
    const action = { type: "approveBuilderFee", signatureChainId: chainId, hyperliquidChain: C.hyperliquidChain, maxFeeRate: C.maxFeeRate, builder: C.builder, nonce };
    const typed = {
      domain: { name: C.domainName, version: "1", chainId: parseInt(chainId, 16), verifyingContract: "0x0000000000000000000000000000000000000000" },
      types: Object.assign({ EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" } ] }, C.types),
      primaryType: C.primaryType,
      message: { hyperliquidChain: action.hyperliquidChain, maxFeeRate: action.maxFeeRate, builder: action.builder, nonce: nonce },
    };
    say("Check the request in your wallet and sign it…");
    const signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [user, JSON.stringify(typed)] });
    say("Sending to Hyperliquid…");
    const res = await fetch(location.pathname + "/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, signature, user }) });
    const result = await res.json();
    if (result.ok) { say("Approved. You can close this page and return to the terminal.", "ok"); return; }
    say(result.message, "bad");
  } catch (error) {
    say(error && error.message ? error.message : String(error), "bad");
  }
  button.disabled = false;
});
</script>
</body>
</html>
`;
}
