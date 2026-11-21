/**
 * The cause of a Python failure, put first: a traceback ends with it, and an answer cut to its
 * first few hundred characters kept only "Traceback (most recent call last): File ..."
 * (about 90 cut Blender errors across 68 bench transcripts). The exception, then where it was
 * raised: the line of the agent's own code, and the kit's file and line when the kit raised it.
 */
export const pythonFailure = (text: string): string | null => {
  const at = text.indexOf("{");
  let body = text;
  if (at >= 0)
    try {
      const parsed = JSON.parse(text.slice(at)) as {
        readonly message?: unknown;
        readonly traceback?: unknown;
      };
      body = [parsed.message, parsed.traceback]
        .filter((part): part is string => typeof part === "string")
        .join("\n");
    } catch {
      // The plain text form: read the lines as they are.
    }
  const lines = body.split("\n").map((line) => line.trim());
  // A wrapper ("RuntimeError: Error: Python: Traceback ...") holds the cause; it is not one.
  const raised = lines.findLast(
    (line) =>
      /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning|Refused)\b.*:/.test(line) &&
      !/Traceback \(most recent call last\):?$/.test(line),
  );
  if (raised === undefined) return null;
  const own = [...body.matchAll(/File "<string>", line (\d+)/g)].at(-1)?.[1];
  const kit = [...body.matchAll(/kurambit\/(\w+\.py)", line (\d+)/g)].at(-1);
  const where = [
    own === undefined ? null : `line ${own} of the code`,
    kit === undefined ? null : `kurambit/${kit[1]} line ${kit[2]}`,
  ].filter((part) => part !== null);
  return `${raised.slice(0, 400)}${where.length === 0 ? "" : ` (at ${where.join(", in ")})`}.\n`;
};
