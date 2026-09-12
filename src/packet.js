/**
 * Packet entry naming and path safety (closes RGM3-007 — zip-slip).
 *
 * A tester supplies the filename of every screenshot they upload. That name
 * reaches a CLI which extracts the packet into the developer's working repo, so
 * a name like `../../.git/hooks/pre-commit` would be written outside the packet
 * directory. The fix is structural: packet entry names are SERVER-assigned, and
 * the tester's original name is carried as data only.
 *
 * Pure module: no fs, no zip library.
 */

/** Screen-reader/Alphabetical-friendly, fixed-width, zero-padded, always .png */
export function packetEntryName(index) {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`packet entry index must be a positive integer, got ${index}`);
  }
  return `screenshot_${String(index).padStart(2, '0')}.png`;
}

export function packetEntryNames(count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  return Array.from({ length: count }, (_, i) => packetEntryName(i + 1));
}

/**
 * Slug used in the derived zip filename (e.g. BUG-142-total-carton-count.zip).
 * Only [a-z0-9-] survives, so it cannot carry a separator, a dot-segment, or a
 * leading dash that would be read as an option by a CLI.
 */
export function packetSlug(text, maxLength = 40) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'bug';
}

/** Derived archive name. Never built from the tester's filename. */
export function packetArchiveName(bugId, title, maxLength = 40) {
  return `${bugId}-${packetSlug(title, maxLength)}.zip`;
}

/**
 * Structural zip-slip guard. Applied to EVERY entry name before it is written,
 * so a bug in the naming code cannot become a write outside the target folder.
 *
 * Rejects: absolute paths, Windows drive/UNC roots, any `..` segment, empty
 * segments, NUL bytes, and backslash separators (which some extractors treat as
 * separators even on POSIX).
 */
export function isSafeRelativePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.includes('\0')) return false;
  if (p.includes('\\')) return false;              // no alternate separators
  if (p.startsWith('/')) return false;             // POSIX absolute
  if (/^[a-zA-Z]:/.test(p)) return false;          // Windows drive-relative/absolute
  if (p.startsWith('~')) return false;             // home expansion
  const segments = p.split('/');
  return segments.every(s => s.length > 0 && s !== '.' && s !== '..');
}

/** Throwing form for use at the write boundary. */
export function assertSafeRelativePath(p) {
  if (!isSafeRelativePath(p)) {
    throw new Error(`unsafe packet entry path: ${JSON.stringify(p)}`);
  }
  return p;
}

/** Join an already-validated entry name under a base directory. */
export function packetPathFor(baseDir, entryName) {
  assertSafeRelativePath(entryName);
  return `${String(baseDir).replace(/\/+$/, '')}/${entryName}`;
}

/**
 * The metadata the server returns with a packet. The tester's original filename
 * lives here — as a JSON string value, never as a filesystem path.
 */
export function buildPacketMeta({ bug, project, milestone, attachments = [] }) {
  return {
    id: bug.id,
    project: { id: project.id, name: project.name, client: project.client, env: project.env },
    milestone: bug.milestoneCode ?? milestone?.code ?? null,
    severity: bug.severity,
    status: bug.status,
    tester: bug.tester,
    reported_at: bug.createdAt,
    updated_at: bug.updatedAt,
    attachments: packetEntryNames(attachments.length).map((name, i) => ({
      name,                                             // server-assigned
      original_filename: attachments[i].filename,        // tester-supplied, data only
      content_type: attachments[i].contentType
    }))
  };
}
