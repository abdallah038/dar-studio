/**
 * Dar Studio — autonomous fulfillment worker (GitHub Actions, runs 24/7).
 * One cycle = one heartbeat:
 *   1. Scan Base chain for USDC deposits to the treasury wallet
 *   2. Match deposit → open order issue by amount+time window
 *   3. Comment receipt on the issue, label "paid"
 *   4. Attach the matching product package files as delivery comment
 *   5. Label "delivered" and close the issue
 * No human in the loop.
 */
import fs from "node:fs";
import path from "node:path";

const WALLET = process.env.DAR_WALLET || "";
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GH = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY; // owner/name at runtime
const STATE_FILE = "brain/worker_state.json";
const PRODUCTS_DIR = "products";

const PRICES = { landing: 14900, bot: 19900, automation: 14900 }; // micro-USDC
const PRODUCT_DIRS = {
  landing: "landing-gen",
  bot: "telegram-lead-bot",
  automation: "automation-scripts",
};

async function gh(method, p, body) {
  const r = await fetch(`https://api.github.com${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "dar-worker",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok && r.status !== 404) {
    console.error("gh err", method, p, r.status);
    return null;
  }
  return r.status === 404 ? null : r.json();
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { last_block: 0, processed: [] };
  }
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

const hexToNum = (h) => parseInt(h, 16);

async function fetchDeposits(fromBlock) {
  const latest = await rpc("eth_blockNumber", []);
  to = hexToNum(latest);
  const logs = await rpc("eth_getLogs", [
    {
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + to.toString(16),
      address: USDC,
      topics: [TRANSFER, null, null],
    },
  ]);
  return { logs, to };
}

let to; // hoisted for fetchDeposits

// ---- main ----
const state = loadState();
if (!state.last_block) {
  // first run: start from now, don't replay history
  const b = await rpc("eth_blockNumber", []);
  state.last_block = hexToNum(b) - 1;
}

const walletTopic = "0x" + "0".repeat(24) + WALLET.toLowerCase().replace(/^0x/, "");
const { logs } = await fetchDeposits(state.last_block + 1);
console.log(`scanned blocks ${state.last_block + 1}..${to}, logs=${logs.length}`);

const deposits = logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.topics[2] === walletTopic);
console.log("deposits to treasury:", deposits.length);

for (const d of deposits) {
  const txHash = d.transactionHash;
  if (state.processed.includes(txHash)) continue;

  const amountMicro = BigInt(d.data).toString();
  const blockNum = hexToNum(d.blockNumber);
  // find matching open order issue (labeled pending_payment)
  const issues = await gh(
    "GET",
    `/repos/${REPO}/issues?labels=pending_payment&state=open&per_page=30&sort=created&direction=asc`
  );
  if (!issues || !issues.length) {
    console.log("deposit but no open orders; recording");
    state.unmatched = state.unmatched || [];
    state.unmatched.push({ txHash, amountMicro, ts: Date.now() });
    state.processed.push(txHash);
    continue;
  }
  // naive match: oldest pending order (fair queue). Amount check per product price map.
  const issue = issues[0];
  const productGuess =
    (issue.title || "").toLowerCase().includes("bot") ? "bot" :
    (issue.title || "").toLowerCase().includes("automation") ? "automation" : "landing";
  const expected = PRICES[productGuess];
  if (BigInt(amountMicro) < expected - 500000) {
    // underpaid (> $0.50 short) → flag, don't deliver
    await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
      body: `⚠️ Received payment of ${(amountMicro / 1e6).toFixed(2)} USDC but the ${productGuess} price is ${(expected / 1e6).toFixed(2)} USDC.\nTx: ${txHash}\nPlease send the difference or contact us.`,
    });
    state.processed.push(txHash);
    continue;
  }

  // mark paid
  await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
    body: `💰 Payment confirmed on-chain\n• Tx: ${txHash}\n• Amount: ${(amountMicro / 1e6).toFixed(2)} USDC on Base\n• Block: ${blockNum}\n\n📦 Preparing your delivery…`,
  });
  await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, { labels: ["paid"] });

  // build delivery: attach product source files inline
  const dir = path.join(PRODUCTS_DIR, PRODUCT_DIRS[productGuess]);
  let delivery = `📦 **Your ${productGuess} is delivered**\n\nFiles are below (also in this repo under \`${dir}\`). Thank you for building with Dar Studio!\n`;
  function walk(dirRel) {
    for (const f of fs.readdirSync(dirRel)) {
      const fp = path.join(dirRel, f);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (fs.statSync(fp).size < 60000) {
        const content = fs.readFileSync(fp, "utf8");
        const lang = f.endsWith(".py") ? "python" : f.endsWith(".html") ? "html" : f.endsWith(".json") ? "json" : "";
        delivery += `\n<details><summary><code>${fp}</code></summary>\n\n\`\`\`${lang}\n${content.slice(0, 40000)}\n\`\`\`\n</details>\n`;
      }
    }
  }
  walk(dir);
  // chunk comments (GH limit ~65k chars)
  for (let i = 0; i < delivery.length; i += 55000) {
    await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
      body: i === 0 ? delivery : "(continued)\n" + delivery.slice(i, i + 55000),
    });
  }
  await gh("PATCH", `/repos/${REPO}/issues/${issue.number}`, {
    state: "closed",
    labels: ["delivered"],
  });
  console.log(`DELIVERED order #${issue.number} (${productGuess}) via ${txHash}`);
  state.processed.push(txHash);
}

state.last_block = to ?? state.last_block;
saveState(state);
console.log("worker cycle complete. processed total:", state.processed.length);
