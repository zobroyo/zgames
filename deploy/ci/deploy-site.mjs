// CI helper: sync site/ to the black box through the zbox MCP.
//
// Reads every text file under site/ (skips catalog.json, which the box
// generates, and binary extensions) and writes it to /srv/zgames/site/ via the
// zbox `zbox_write_file` tool. The repo is public, so no box credential is
// needed for the read side; the MCP bearer token comes from ZBOX_MCP_TOKEN.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const MCP_URL = process.env.MCP_URL || "https://mcp.z-chat.men/mcp";
const TOKEN = process.env.MCP_TOKEN || "";

const SKIP = new Set(["catalog.json"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|mp4|wasm|zip)$/i;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

async function call(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error) {
    throw new Error(`${name} failed: ${res.status} ${JSON.stringify(body?.error || body)}`);
  }
  return body.result;
}

const files = walk("site").filter((f) => {
  const name = f.split(sep).pop();
  return !SKIP.has(name) && !BINARY.test(name);
});

let ok = 0;
for (const file of files) {
  const rel = relative("site", file).split(sep).join("/");
  const dest = `/srv/zgames/site/${rel}`;
  const content = readFileSync(file, "utf8");
  await call("zbox_write_file", { path: dest, content });
  console.log(`→ ${dest} (${Buffer.byteLength(content)} bytes)`);
  ok += 1;
}
console.log(`Deployed ${ok} file(s) to the box.`);
