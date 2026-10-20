import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { ask, askHidden } from "./prompt.js";

// Deploys DogMaAI's Tinybird tables (tinybird/datasources) to a workspace used only by DogMaAI, then saves a token
// that can only add to and read those tables. At the owner's request, the workspace admin token is typed once, hidden,
// and kept in .env as TINYBIRD_ADMIN_TOKEN, so later runs (after a table changes) need no typing. Only this script
// reads it; the DogMaAI API removes it from its environment and uses the add-and-read token.
// Usage: npm run tinybird:setup
const tables = new Set(readdirSync("tinybird/datasources").filter(name => name.endsWith(".datasource")).map(name => name.replace(/\.datasource$/, "")));
const appToken = "dogmaai_app";

function saveEnv(values: Record<string, string>) {
  let text = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(".env", text, { mode: 0o600 });
}

// Tinybird tokens carry their region, such as "aws-us-west-2", which suggests the API host.
function suggestedHost(token: string) {
  try {
    const region = String(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")).host ?? "");
    const aws = /^aws-(.+)$/.exec(region);
    if (aws) return aws[1] === "us-east-1" ? "https://api.us-east.aws.tinybird.co" : `https://api.${aws[1]}.aws.tinybird.co`;
    const gcp = region.replace(/^gcp-/, "");
    if (gcp === "europe-west3") return "https://api.tinybird.co";
    if (gcp === "us-east4") return "https://api.us-east.tinybird.co";
    return gcp ? `https://api.${gcp}.gcp.tinybird.co` : "";
  } catch {
    return "";
  }
}

// Pasting can bring along spaces, line breaks, quotes or a terminal's paste markers; a token has none of them.
const clean = (text: string) => text.replace(/\u001b\[20[01]~/g, "").replace(/\s+/g, "").replace(/^["']|["']$/g, "");
// Asked hidden, so a paste never lands in a visible prompt.
async function askToken() {
  const token = clean(await askHidden("Workspace admin token (typing is hidden): "));
  if (!token) throw new Error("Enter the admin token. Nothing was saved.");
  return token;
}
// The token's own region decides the API host; the saved host fills in when the region cannot be read.
async function hostFor(token: string) {
  let entered = suggestedHost(token) || process.env.TINYBIRD_API_URL?.trim() || "";
  if (!entered) {
    console.log("That token's region could not be read, so it may not have been pasted in full. Type the API host to continue, or press Ctrl+C and paste the token again.");
    entered = await ask("API host, such as https://api.us-west-2.aws.tinybird.co: ");
    if (/^p\.|^eyJ/.test(entered) || entered.length > 120) throw new Error("That looks like a token, not the API host. Nothing was saved. Since it was shown on screen, refresh that token in Tinybird before trying again.");
  }
  const url = new URL(entered.includes("://") ? entered : `https://${entered}`);
  if (url.protocol !== "https:" || !/(^|\.)tinybird\.co$/.test(url.hostname)) throw new Error("Enter the workspace's Tinybird API host. Nothing was saved.");
  return url.origin;
}
const listTables = (host: string, token: string) => fetch(`${host}/v0/datasources`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });

try {
  const saved = clean(process.env.TINYBIRD_ADMIN_TOKEN ?? "");
  console.log(saved ? "Using the Tinybird admin token saved in .env." : "In Tinybird, open the workspace used only for DogMaAI and copy the admin token from its Tokens page. It is kept in .env, so this is asked only once.");
  let admin = saved || await askToken();
  let host = await hostFor(admin);
  let listing = await listTables(host, admin);
  if (saved && (listing.status === 401 || listing.status === 403)) {
    await listing.body?.cancel();
    console.log("Tinybird refused the admin token saved in .env; it may have been refreshed. Paste the current one from the workspace's Tokens page.");
    admin = await askToken();
    host = await hostFor(admin);
    listing = await listTables(host, admin);
  }
  if (!listing.ok) throw new Error(`Tinybird answered HTTP ${listing.status}. Check the admin token and that the host is this workspace's region. Nothing was saved.`);
  const auth = { Authorization: `Bearer ${admin}` };

  // A deployment defines everything in a workspace, so refuse one that holds another project's tables.
  const others = ((await listing.json()) as { datasources: { name: string }[] }).datasources.map(item => item.name).filter(name => !tables.has(name));
  if (others.length) throw new Error(`This workspace also holds ${others.join(", ")}. Use a workspace only for DogMaAI, so deploying cannot affect another project. Nothing was changed.`);
  // The token works for a workspace that holds only DogMaAI's tables, so it is kept for the next run.
  saveEnv({ TINYBIRD_ADMIN_TOKEN: admin, TINYBIRD_API_URL: host });

  // The Tinybird CLI deploys; the token reaches it through its environment and is never printed.
  const cli = process.env.TINYBIRD_CLI?.trim() || "tb";
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TB_TOKEN: admin, TB_HOST: host, TB_VERSION_WARNING: "0", TB_CLI_TELEMETRY_OPTOUT: "1" };
  for (const args of [["--cloud", "deploy", "--check"], ["--cloud", "deploy"]]) {
    const run = spawnSync(cli, args, { cwd: "tinybird", env, stdio: "inherit" });
    if (run.error) throw new Error(`Could not run the Tinybird CLI (${cli}). Install it, or set TINYBIRD_CLI in .env to its path.`);
    if (run.status !== 0) throw new Error(`tb ${args.slice(1).join(" ")} did not succeed; see the output above. Nothing was deployed. The admin token is saved, so run npm run tinybird:setup again once it is fixed.`);
  }

  // DogMaAI keeps only the token the deployment created for it.
  const token = await fetch(`${host}/v0/tokens/${appToken}`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!token.ok) throw new Error(`The tables are deployed, but Tinybird answered HTTP ${token.status} for the ${appToken} token. Run npm run tinybird:setup again.`);
  const value = ((await token.json()) as { token?: string }).token;
  if (!value) throw new Error(`Tinybird did not return the ${appToken} token. Run npm run tinybird:setup again.`);
  saveEnv({ TINYBIRD_TOKEN: value });
  console.log(`Deployed ${new Intl.ListFormat("en", { type: "conjunction" }).format([...tables])}, and saved the ${appToken} token (add and read only) to .env. Restart DogMaAI to start saving the diary, PetAnalytics and telemetry.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
