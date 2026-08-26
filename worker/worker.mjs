/**
 * Dar Studio — autonomous fulfillment worker v2 (GitHub Actions, runs 24/7).
 * One cycle:
 *   1. Scan Base chain for USDC deposits to the treasury wallet
 *   2. Match deposit -> open order issue (price-aware)
 *   3. Comment receipt, label "paid"
 *   4. Deliver product files INLINE from products/
 *   5. Label "delivered", close issue
 */
import fs from "node:fs";
import path from "node:path";

const WALLET = (process.env.DAR_WALLET || "0x1EA7D86408b734563cF461001E9d554D327D8550");
const RPC = "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // native USDC on Base
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const GH = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const STATE_FILE = "worker/worker_state.json";
const PRODUCTS_DIR = "products";

// micro-USDC (6 decimals): $19 = 19_000_000
const PRICES = {
  pack: 19_000_000,        // template pack instant
  landing59: 59_000_000,   // launch-week landing
  landing: 149_000_000,
  bot: 199_000_000,
  automation: 149_000_000,
};
const DELIVERY_DIRS = {
  pack: "template-pack",
  landing59: "template-pack",
  landing: "template-pack",
  bot: "template-pack",
  automation: "template-pack",
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
  for (const endpoint of ["https://base.publicnode.com", RPC]) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = await r.json();
      if (j && j.result !== undefined) return j.result;
    } catch (e) { /* try next */ }
  }
  return null;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { last_block: 0, processed: [] }; }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

const hexToNum = (h) => parseInt(h, 16);
let to;

async function fetchDeposits(fromBlock) {
  const latest = await rpc("eth_blockNumber", []);
  if (!latest) return { logs: [], to: fromBlock };
  to = hexToNum(latest);
  const logs = await rpc("eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + to.toString(16),
    address: USDC,
    topics: [TRANSFER, null, null],
  }]);
  return { logs, to };
}

function guessProduct(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("pack") || t.includes("$19")) return "pack";
  if (t.includes("$59") || t.includes("launch")) return "landing59";
  if (t.includes("bot")) return "bot";
  if (t.includes("automation")) return "automation";
  if (t.includes("149")) return "landing";
  return "landing59"; // default = current entry offer
}

function buildDelivery(productKey) {
  const rel = path.join(PRODUCTS_DIR, DELIVERY_DIRS[productKey] || "template-pack");
  let out = `📦 **Delivered — thank you for building with Dar Studio!**\n\nFiles are below (also in this repo under \`${rel}\`).\n`;
  if (!fs.existsSync(rel)) {
    out += "\n_(product folder missing — contact us and we will send files directly)_\n";
    return out;
  }
  (function walk(dirRel) {
    for (const f of fs.readdirSync(dirRel)) {
      const fp = path.join(dirRel, f);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (fs.statSync(fp).size < 60000) {
        const content = fs.readFileSync(fp, "utf8");
        const lang = f.endsWith(".py") ? "python" : f.endsWith(".html") ? "html" : f.endsWith(".json") ? "json" : "";
        out += `\n<details><summary><code>${fp}</code></summary>\n\n\`\`\`${lang}\n${content.slice(0, 40000)}\n\`\`\`\n</details>\n`;
      }
    }
  })(rel);
  if (productKey !== "pack") {
    out += "\n> 🛠️ Your **custom brand version** is being prepared — a private preview link will be posted here within 24h.\n";
  }
  return out;
}

// ---- main ----
const state = loadState();
if (!state.last_block) {
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

  const issues = await gh("GET", `/repos/${REPO}/issues?labels=pending_payment&state=open&per_page=30&sort=created&direction=asc`);
  if (!issues || !issues.length) {
    console.log("deposit but no open orders; recording as unmatched");
    state.unmatched = state.unmatched || [];
    state.unmatched.push({ txHash, amountMicro, ts: Date.now() });
    state.processed.push(txHash);
    continue;
  }

  // pick best-matching order: whose expected price fits the deposit (within $0.50), prefer exact-ish then oldest
  let chosen = null, chosenKey = null;
  for (const issue of issues) {
    const key = guessProduct(issue.title);
    const expected = PRICES[key];
    if (BigInt(amountMicro) >= BigInt(expected - 500_000)) {
      if (!chosen || PRICES[chosenKey] < expected) { chosen = issue; chosenKey = key; }
    }
  }

  if (!chosen) {
    const issue = issues[0];
    const key = guessProduct(issue.title);
    await gh("POST", `/repos/${REPO}/issues/${issue.number}/comments`, {
      body: `⚠️ Received ${(Number(amountMicro) / 1e6).toFixed(2)} USDC but the ${key} price is ${(PRICES[key] / 1e6).toFixed(2)} USDC.\nTx: ${txHash}\nPlease send the difference or comment here.`,
    });
    state.processed.push(txHash);
    continue;
  }

  await gh("POST", `/repos/${REPO}/issues/${chosen.number}/comments`, {
    body: `💰 Payment confirmed on-chain\n• Tx: ${txHash}\n• Amount: ${(Number(amountMicro) / 1e6).toFixed(2)} USDC on Base\n• Block: ${blockNum}\n\n📦 Preparing your delivery…`,
  });
  await gh("PATCH", `/repos/${REPO}/issues/${chosen.number}`, { labels: ["paid"] });

  const delivery = buildDelivery(chosenKey);
  for (let i = 0; i < delivery.length; i += 55000) {
    await gh("POST", `/repos/${REPO}/issues/${chosen.number}/comments`, {
      body: i === 0 ? delivery : "(continued)\n" + delivery.slice(i, i + 55000),
    });
  }
  await gh("PATCH", `/repos/${REPO}/issues/${chosen.number}`, { state: "closed", labels: ["delivered"] });
  console.log(`DELIVERED order #${chosen.number} (${chosenKey}) via ${txHash}`);
  state.processed.push(txHash);
}

state.last_block = to ?? state.last_block;
saveState(state);
console.log("worker cycle complete. processed total:", state.processed.length);
