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

/**
 * The extension is chosen by the SERVER from the validated content type, never
 * taken from the tester's filename. Only these types may reach a packet — the
 * first revision hard-coded `.png` while `buildPacketMeta` preserved arbitrary
 * content types, so a JPEG was written as `screenshot_01.png` with
 * `image/jpeg` metadata and no conversion existed.
 */
export const PACKET_IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic'
});

export function extensionFor(contentType) {
  const base = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  const ext = PACKET_IMAGE_EXTENSIONS[base];
  if (!ext) throw new RangeError(`unsupported packet image type: ${contentType}`);
  return ext;
}

/** Fixed-width, zero-padded, extension derived from the validated type. */
export function packetEntryName(index, contentType = 'image/png') {
  if (!Number.isInteger(index) || index < 1) {
    throw new RangeError(`packet entry index must be a positive integer, got ${index}`);
  }
  return `screenshot_${String(index).padStart(2, '0')}.${extensionFor(contentType)}`;
}

export function packetEntryNames(count, contentTypes = []) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative integer, got ${count}`);
  }
  return Array.from({ length: count }, (_, i) =>
    packetEntryName(i + 1, contentTypes[i] ?? 'image/png'));
}

/**
 * Slug used in the derived zip filename (e.g. BUG-142-ton-carton-sai.zip).
 *
 * Safety comes from stripping every separator and dot-segment — NOT from
 * discarding non-ASCII. Restricting this to [a-z0-9] turned a Vietnamese title
 * into `s-l-ng-th-ng-kh-ng-...`, which is useless to the developer reading it.
 * So: keep letters and digits in ANY script (NFC-normalised), collapse everything
 * else to a dash, and never leave a leading dash (which a CLI would read as a
 * flag) or a trailing one.
 */
export function packetSlug(text, maxLength = 40) {
  const slug = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')   // any separator, dot or punctuation -> '-'
    .replace(/^-+|-+$/g, '')
    // slice by code point so a multi-byte character is never cut in half
    .split('').slice(0, maxLength).join('')
    .replace(/-+$/g, '');
  return slug || 'bug';
}

/** Derived archive name. Never built from the tester's filename. */
export function packetArchiveName(bugId, title, maxLength = 40) {
  return `${bugId}-${packetSlug(title, maxLength)}.zip`;
}

/**
 * RFC 6266 Content-Disposition for a filename that may not be ASCII.
 *
 * HTTP header values are not defined for raw UTF-8, so a Vietnamese archive name
 * needs both a quoted ASCII fallback and the `filename*` form with percent
 * encoding. Sending only the raw name mangles it in some clients.
 */
export function contentDisposition(filename, asciiFallback) {
  const ascii = String(asciiFallback ?? filename)
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
    // Bug or feature request. The fields below are picked explicitly, so anything added
    // to the caller's object has to be added here too or it silently disappears.
    kind: bug.kind ?? 'bug',
    project: { id: project.id, name: project.name, client: project.client, env: project.env },
    milestone: bug.milestoneCode ?? milestone?.code ?? null,
    severity: bug.severity,
    status: bug.status,
    tester: bug.tester,
    reported_at: bug.createdAt,
    updated_at: bug.updatedAt,
    attachments: packetEntryNames(
      attachments.length, attachments.map(a => a.contentType)
    ).map((name, i) => ({
      name,                                               // server-assigned
      id: attachments[i].id ?? null,                      // stable DB identity
      original_filename: attachments[i].filename,          // tester-supplied, data only
      content_type: attachments[i].contentType,
      uploaded_at: attachments[i].uploadedAt ?? null,
      attached_to_event: attachments[i].eventId ?? null    // ties a shot to a timeline moment
    }))
  };
}
