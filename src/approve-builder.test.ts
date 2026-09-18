import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import {
  parseApproveArgs,
  runApproveBuilder,
  startApprovalServer,
  type ApprovalClient,
  type ApproveDeps,
} from "./approve-builder.js";
import { approveBuilderFeeAction } from "./builder-approval.js";
import { signLikeAWallet, testWallet as wallet } from "./test-support/wallet.js";
import type { ApprovalRequest } from "./builder-approval.js";

const BUILDER = "0x658DC3a1fc753262c83c7345032E6DB7Aa8fA997";
const NOW = Date.UTC(2026, 8, 18, 19);

function fakeClient(opts: { refuse?: string; approved?: number } = {}) {
  const submitted: ApprovalRequest[] = [];
  const client: ApprovalClient = {
    submitBuilderApproval: async (request) => {
      submitted.push(request);
      return opts.refuse ? { ok: false, message: opts.refuse } : { ok: true };
    },
    maxBuilderFee: async () => opts.approved ?? 20,
  };
  return { client, submitted };
}

/** Raw HTTP, so a test can send a Host header that fetch would not. */
function call(url: string, init: { method?: string; body?: unknown; host?: string } = {}) {
  const { hostname, port, pathname } = new URL(url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        path: pathname,
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", ...(init.host ? { Host: init.host } : {}) },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(JSON.stringify(init.body));
    req.end();
  });
}

async function signedSubmission(overrides: Partial<Parameters<typeof approveBuilderFeeAction>[0]> = {}) {
  const action = approveBuilderFeeAction({
    builder: BUILDER,
    maxFeeTenthsBps: 20,
    network: "mainnet",
    signatureChainId: "0xa4b1",
    nonce: NOW,
    ...overrides,
  });
  return { action, signature: await signLikeAWallet(action), user: wallet.address };
}

async function session(client: ApprovalClient, timeoutMs = 5_000) {
  return startApprovalServer(
    { builder: BUILDER, maxFeeTenthsBps: 20, network: "mainnet" },
    { client, now: () => NOW, timeoutMs },
  );
}

describe("parseApproveArgs", () => {
  it("defaults to Reins' 2 bp on mainnet, opening the browser", () => {
    expect(parseApproveArgs([])).toMatchObject({ maxFeeTenthsBps: 20, network: "mainnet", open: true });
  });

  it("takes a higher ceiling, up to the cap", () => {
    expect(parseApproveArgs(["--max-fee", "5"]).maxFeeTenthsBps).toBe(50);
    expect(() => parseApproveArgs(["--max-fee", "11"])).toThrow(/at most 10 bp/);
    expect(() => parseApproveArgs(["--max-fee", "0.25"])).toThrow(/0.1 steps/);
  });

  it("wants a real address to check", () => {
    expect(() => parseApproveArgs(["--check", "me"])).toThrow(/wallet address/);
  });
});

describe("the approval page", () => {
  it("serves the page with the builder and rate, and nothing to other hosts or paths", async () => {
    const s = await session(fakeClient().client);
    const page = await call(s.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain(BUILDER);
    expect(page.body).toContain("0.02%");
    expect(page.body).toContain("main wallet");

    expect((await call(s.url, { host: "evil.example:80" })).status).toBe(403);
    expect((await call(`${new URL(s.url).origin}/wrong-token`)).status).toBe(404);
    s.close();
  });

  it("sends a correct approval to Hyperliquid and reads it back", async () => {
    const { client, submitted } = fakeClient({ approved: 20 });
    const s = await session(client);
    const res = await call(`${s.url}/submit`, { method: "POST", body: await signedSubmission() });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, approvedTenthsBps: 20 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.action.maxFeeRate).toBe("0.02%");
    expect(await s.done).toEqual({ ok: true, user: wallet.address, approvedTenthsBps: 20 });
  });

  it("refuses a tampered approval without sending it, and keeps waiting", async () => {
    const { client, submitted } = fakeClient();
    const s = await session(client);
    const res = await call(`${s.url}/submit`, {
      method: "POST",
      body: await signedSubmission({ maxFeeTenthsBps: 100 }),
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).message).toMatch(/is for 0.1%/);
    expect(submitted).toHaveLength(0);

    await call(`${s.url}/submit`, { method: "POST", body: await signedSubmission() });
    expect((await s.done).ok).toBe(true);
  });

  it("reports Hyperliquid's refusal", async () => {
    const s = await session(fakeClient({ refuse: "Must deposit before performing actions." }).client);
    await call(`${s.url}/submit`, { method: "POST", body: await signedSubmission() });
    expect(await s.done).toEqual({
      ok: false,
      message: "Hyperliquid refused it: Must deposit before performing actions.",
    });
  });

  it("gives up after the timeout", async () => {
    const s = await session(fakeClient().client, 20);
    expect(await s.done).toMatchObject({ ok: false, message: expect.stringMatching(/in time/) });
  });
});

describe("runApproveBuilder", () => {
  function deps(client: ApprovalClient) {
    const out: string[] = [];
    let opened = "";
    const d: ApproveDeps = {
      clientFor: () => client,
      out: (text) => out.push(text),
      openBrowser: (url) => {
        opened = url;
      },
      now: () => NOW,
      builderAddress: BUILDER,
    };
    return { d, out: () => out.join(""), opened: () => opened };
  }

  it("opens the page, waits, and prints the approval", async () => {
    const { d, out, opened } = deps(fakeClient({ approved: 20 }).client);
    const run = runApproveBuilder([], d);
    await vi_waitFor(() => opened() !== "");
    await call(`${opened()}/submit`, { method: "POST", body: await signedSubmission() });
    await run;

    expect(out()).toContain("Sign in your browser with your main wallet");
    expect(out()).toContain(`✓ Approved: ${wallet.address} allows Reins up to 2 bp (0.02%) on mainnet.`);
  });

  it("--check reports what a wallet has approved", async () => {
    const approved = deps(fakeClient({ approved: 20 }).client);
    await runApproveBuilder(["--check", wallet.address], approved.d);
    expect(approved.out()).toContain("has approved Reins for up to 2 bp (0.02%)");

    const none = deps(fakeClient({ approved: 0 }).client);
    await runApproveBuilder(["--check", wallet.address], none.d);
    expect(none.out()).toContain("has not approved");
  });

  it("refuses when this build has no builder address", async () => {
    const { d } = deps(fakeClient().client);
    await expect(runApproveBuilder([], { ...d, builderAddress: "" })).rejects.toThrow(/no builder address/);
  });
});

async function vi_waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!condition()) throw new Error("Timed out waiting.");
}
