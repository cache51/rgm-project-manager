/**
 * Pasted people: an address per line, with an optional name beside it.
 *
 * Adding a tester list one address at a time is the kind of job that gets deferred, and
 * a deferred job leaves the roster wrong — so the roster form takes a paste instead.
 * This parses what a person actually pastes, without ever guessing an address:
 *
 *   yang@rgmdn.com
 *   thibinh@rgmdn.com
 *   muahang1@rgmdn.com, Hien            <- a bare word names the address before it
 *   acc02@rgmdn.com - Hien              <- "- ", ": ", a tab or nothing all work
 *   Hien acc02@rgmdn.com                <- so does the name first
 *
 * Anything without an `@` is treated as the name of the entry before it rather than as
 * a failed address: a typo'd address and a name look the same, and of the two ways to be
 * wrong, quietly attaching a name is the recoverable one — the address is still added
 * under its own text and the person fixing it sees it in the roster.
 *
 * Pure module: no DB, no HTTP.
 */

/** A paste bigger than this is a mistake or an attack, not a team. */
export const MAX_PEOPLE_PER_CALL = 50;

const EMAIL = /[^\s@:,;]+@[^\s@:,;]+/g;
/** Separators that survive inside one pasted line around a name. */
const NAME_TRIM = /[\s\-–—:]+/g;

/**
 * @param {string|string[]} input — the textarea's value, or an array of addresses.
 * @returns {{email: string, name: string|null}[]} deduped, in the order pasted.
 */
export function parsePeople(input) {
  const text = Array.isArray(input) ? input.join('\n') : String(input ?? '');
  const entries = text.split(/[\n\r;,]+/).map((s) => s.trim()).filter(Boolean);

  // Insertion-ordered, keyed by lowercased address so a paste listing someone twice
  // does not try to add them twice.
  const byEmail = new Map();
  const lastAdded = () => [...byEmail.values()].pop() ?? null;
  // A name with nobody before it yet: "Hien" on its own line, then the address.
  let pendingName = null;

  for (const entry of entries) {
    const found = entry.match(EMAIL);
    if (!found) {
      // No address at all: it names the entry before it ("acc02@rgmdn.com, Hien"),
      // or the one after it, when there is nothing before it to name.
      const previous = lastAdded();
      if (previous && !previous.name) previous.name = entry;
      else pendingName ??= entry;
      continue;
    }

    // Everything that is not an address is the name, whatever it was wrapped in.
    const leftover = found.reduce((s, address) => s.replace(address, ' '), entry);
    const onLine = leftover.replace(NAME_TRIM, ' ').trim() || null;
    const name = onLine ?? pendingName;
    pendingName = null;

    found.forEach((address, i) => {
      const key = address.toLowerCase();
      const existing = byEmail.get(key);
      if (existing) {
        // A second mention may carry the name the first one lacked.
        if (!existing.name && i === 0 && name) existing.name = name;
        return;
      }
      byEmail.set(key, { email: address, name: i === 0 ? name : null });
    });
  }

  return [...byEmail.values()].slice(0, MAX_PEOPLE_PER_CALL);
}