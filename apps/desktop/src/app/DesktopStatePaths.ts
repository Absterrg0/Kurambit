import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(kurambitHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(kurambitHome)) {
    return Option.none();
  }
  const trimmed = kurambitHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly kurambitHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.kurambitHome), () =>
    input.joinPath(input.homeDirectory, ".kurambit"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly kurambitHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.kurambitHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
