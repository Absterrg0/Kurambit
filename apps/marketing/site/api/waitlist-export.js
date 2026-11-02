import { database, send, tokenMatches } from "./_lib.js";

// Spreadsheet apps execute cells that start with these; prefix them so a
// signup cannot plant a formula in the export.
const csvCell = (value) => {
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, { error: "method" });
  }
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!tokenMatches(token, process.env.WAITLIST_ADMIN_TOKEN)) {
    return send(response, 404, { error: "not-found" });
  }
  const sql = database();
  if (!sql) return send(response, 503, { error: "closed" });

  const rows = await sql`
    select email, name, role, source, created_at from waitlist order by created_at asc`;
  const lines = [
    "email,name,role,source,signed_up_at",
    ...rows.map((row) =>
      [row.email, row.name, row.role, row.source, new Date(row.created_at).toISOString()]
        .map(csvCell)
        .join(","),
    ),
  ];
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/csv; charset=utf-8");
  response.setHeader("Content-Disposition", 'attachment; filename="kurambit-waitlist.csv"');
  response.status(200).send(`${lines.join("\n")}\n`);
}
