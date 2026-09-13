#!/bin/bash
# Show where to sign in, and which addresses the app will recognise.
#
# There is no link to mint any more: sign-in is an address, so the useful thing to
# print is the list of addresses that will actually work. Usage:
#
#   bash scripts/dev-login.sh              # list the known addresses
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${RGM_LOCAL_DIR:-$HOME/.rgm-local}"
PORT="${PORT:-3000}"

echo "Open:  http://127.0.0.1:$PORT/login"
echo "Sign in with any address below."
echo

cd "$HERE"
PGLITE_DIR="$DATA/pg" node --input-type=module -e '
import { createDb } from "./src/db.js";
const db = await createDb({ dataDir: process.env.PGLITE_DIR });
const { rows } = await db.query(
  `SELECT u.email, u.display_name,
          string_agg(DISTINCT m.role, $$/$$ ORDER BY m.role) AS roles
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
    GROUP BY u.email, u.display_name
    ORDER BY u.email`);
if (!rows.length) {
  console.log("  (nobody yet — run: npm run bootstrap -- you@example.com)");
}
for (const r of rows) {
  const who = r.display_name ? ` (${r.display_name})` : "";
  console.log(`  ${r.email}${who}  ${r.roles ? "[" + r.roles + "]" : ""}`);
}
await db.close();
'
