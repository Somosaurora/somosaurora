// GET /api/featured — Top de opiniones del informe más reciente (público).
// Vercel Edge Function. Lee con la anon key (solo lectura, permitido por RLS).

export const config = { runtime: "edge" };

export default async function handler(request) {
  if (request.method !== "GET") return new Response("Método no permitido", { status: 405 });
  const env = process.env;
  // Acepta tanto los nombres estándar como los que quedaron puestos en Vercel.
  const SUPA_URL = env.SUPABASE_URL || env.ProjectURL || "";
  const SUPA_ANON = env.SUPABASE_ANON_KEY || env.anonpublic || "";
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" };
  try {
    const h = { apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` };

    // 1) Informe más reciente
    const rep = await fetch(
      `${SUPA_URL}/rest/v1/weekly_reports?select=id,week_start,week_end,created_at&order=created_at.desc&limit=1`,
      { headers: h }
    );
    const reports = rep.ok ? await rep.json() : [];
    if (!reports.length) return new Response(JSON.stringify({ ok: true, items: [], report: null }), { headers });

    const report = reports[0];

    // 2) Sus destacadas (máx. 5, las del carrusel), ordenadas por rank
    const feat = await fetch(
      `${SUPA_URL}/rest/v1/featured_opinions?report_id=eq.${report.id}` +
        `&select=rank,tipo,tema,sector,texto,autor_display,created_at&order=rank.asc&limit=5`,
      { headers: h }
    );
    const items = feat.ok ? await feat.json() : [];
    return new Response(JSON.stringify({ ok: true, items, report }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, items: [], error: String(e) }), { headers });
  }
}
