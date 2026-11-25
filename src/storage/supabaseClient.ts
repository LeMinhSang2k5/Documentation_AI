import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function createSupabaseAdminClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (
    !supabaseUrl ||
    !serviceRoleKey ||
    supabaseUrl.includes("<your-project-ref>") ||
    serviceRoleKey === "your-service-role-key"
  ) {
    throw new Error(
      "Missing valid SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment (.env). " +
        "Please configure your Team 2.1 Supabase project credentials and run supabase/schema.sql."
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
