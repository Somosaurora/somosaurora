// GET /api/config — Config pública para el panel admin (supabase-js en el navegador).
// Vercel Edge Function. Solo devuelve URL + ANON key (públicas). Nunca la service_role.

export const config = { runtime: "edge" };

export default async function handler() {
  const env = process.env;
  // Acepta tanto los nombres estándar como los que quedaron puestos en Vercel.
  const url = env.SUPABASE_URL || env.ProjectURL || "";
  const anonKey = env.SUPABASE_ANON_KEY || env.anonpublic || "";
  return new Response(
    JSON.stringify({ url, anonKey }),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
