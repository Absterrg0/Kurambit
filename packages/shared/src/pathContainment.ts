// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "./HostProcess.ts";

/** Both paths must come from `realPathForContainment`. */
export function isPathWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

// Win32 file APIs drop trailing dots and spaces from a name and read `:` as a
// stream separator, but Node opens paths verbatim (`\\?\`). So `link./file`
// is a missing folder to Node and the link's target to an agent or a shell.
const isRewrittenByWin32 = (name: string) =>
  name !== "." && name !== ".." && (/[. ]$/.test(name) || name.includes(":"));

/**
 * The real path that opening an absolute `path` as written reaches, or
 * `undefined` when that cannot be known and a containment check must fail.
 * A file that does not exist yet resolves through its deepest existing
 * ancestor; a dangling link fails.
 */
export function realPathForContainment(path: string): string | undefined {
  if (!NodePath.isAbsolute(path)) return undefined;
  if (
    HostProcess.Platform.defaultValue() === "win32" &&
    path.slice(NodePath.parse(path).root.length).split(/[\\/]/).some(isRewrittenByWin32)
  ) {
    return undefined;
  }
  // Not normalized first: POSIX follows `link` before `..` in `link/../file`.
  let candidate = path;
  const missingSuffix: Array<string> = [];
  while (true) {
    try {
      return NodePath.resolve(NodeFS.realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
    }
    try {
      NodeFS.lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return undefined;
    }
    const parent = NodePath.dirname(candidate);
    const name = NodePath.basename(candidate);
    // `mkdir -p missing/../link/dir` creates `missing`, steps back, and
    // follows `link`; resolving `..` here would skip that link.
    if (parent === candidate || name === "..") return undefined;
    missingSuffix.unshift(name);
    candidate = parent;
  }
}
