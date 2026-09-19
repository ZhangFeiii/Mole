const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { fingerprint } = require("./safe-trash.cjs");
const { isWithin } = require("./security.cjs");

// IDs are minted from a completed, authorized scan before its result reaches
// the renderer. An execution request can never supply its own path or root.
function createAnalysisSelections({
  platform = process.platform,
  inspectAttributes,
  protectedRoots = [],
  protectedFiles = [],
} = {}) {
  let records = new Map();
  const selfProtected = (value) =>
    protectedRoots.some((root) => isWithin(root, value)) ||
    protectedFiles.some((file) => path.resolve(file) === path.resolve(value));
  return {
    clear() {
      records = new Map();
    },
    async bind(result, authorizedRoot) {
      const bound = structuredClone(result);
      records = new Map();
      if (platform !== "win32") return bound;
      const entries = [...(bound.entries || []), ...(bound.largeFiles || [])];
      const files = [
        ...new Map(
          entries
            .filter(
              (entry) =>
                entry &&
                !entry.directory &&
                typeof entry.path === "string" &&
                path.isAbsolute(entry.path) &&
                isWithin(authorizedRoot, entry.path) &&
                !selfProtected(entry.path),
            )
            .map((entry) => [entry.path, entry]),
        ).values(),
      ].slice(0, 500);
      if (!files.length) return bound;
      const rows = await inspectAttributes(files.map((entry) => entry.path));
      const attributes = new Map(rows.map((row) => [row.path, row]));
      const ids = new Map();
      for (const entry of files) {
        const native = attributes.get(entry.path);
        if (
          !native ||
          native.error ||
          !Number.isInteger(native.attributes) ||
          native.inUse !== false ||
          native.attributes &
            (0x1 | 0x4 | 0x10 | 0x400 | 0x1000 | 0x40000 | 0x400000)
        )
          continue;
        try {
          const stat = await fs.lstat(entry.path, { bigint: true });
          const modified = Date.parse(entry.modified);
          if (
            !Number.isFinite(modified) ||
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1n ||
            stat.ino === 0n ||
            stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
            Number(stat.size) !== entry.size ||
            Math.abs(Number(stat.mtimeMs) - modified) >= 1
          )
            continue;
          const id = randomUUID();
          records.set(id, {
            id,
            path: entry.path,
            root: authorizedRoot,
            size: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            identity: fingerprint(stat),
          });
          ids.set(entry.path, id);
        } catch {
          /* A changed file remains read-only until another scan. */
        }
      }
      for (const entry of entries) {
        const id = ids.get(entry.path);
        if (id) {
          entry.entryId = id;
          entry.trashable = true;
        }
      }
      return bound;
    },
    async authorize(ids) {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 500 ||
        ids.some((id) => typeof id !== "string" || !records.has(id)) ||
        new Set(ids).size !== ids.length
      )
        throw new Error("文件选择已变化，请从当前扫描结果重新选择");
      if (ids.some((id) => selfProtected(records.get(id).path)))
        throw new Error("Mole 自身程序和操作记录受到保护");
      return ids.map((id) => structuredClone(records.get(id)));
    },
  };
}
module.exports = { createAnalysisSelections };
