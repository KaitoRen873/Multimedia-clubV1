// Supabase Edge Function: delete-user
// ------------------------------------------------------------
// Deleting someone's login (not just their profile row) requires
// the service_role key, which must NEVER be shipped to a browser.
// This function runs on Supabase's servers, holds that key safely,
// and only allows an already-authenticated, non-suspended
// administrator to call it.
//
// Deploy with the Supabase CLI:
//   supabase functions deploy delete-user
//
// Call it from the browser like:
//   const { data, error } = await sb.functions.invoke('delete-user', {
//     body: { user_id: targetUserId }
//   });
//
// Deleting the auth.users row cascades to public.profiles automatically
// (see the "on delete cascade" foreign key in schema.sql), so this one
// call cleans up both — no separate profile delete needed.
//
// (This function is optional for v1 — without it, the admin dashboard's
// "Delete" button still removes the member's profile data and blocks
// their app access via RLS; it just leaves the underlying Supabase Auth
// login in place until removed here or from the dashboard.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Browsers send a CORS preflight before the real POST — handle it first.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Use POST" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: "Server misconfigured: missing Supabase environment variables" }, 500);
  }

  try {
    // ---- 1. Identify the caller from their own JWT ----
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) {
      return json({ error: "Not authenticated" }, 401);
    }

    // ---- 2. Confirm the caller is an active administrator ----
    // (This re-checks server-side; RLS also protects the underlying
    // table, but we want a clean, explicit error message here.)
    const { data: callerProfile, error: profileError } = await callerClient
      .from("profiles")
      .select("account_type, suspended")
      .eq("id", user.id)
      .single();
    if (profileError || !callerProfile || callerProfile.account_type !== "administrator" || callerProfile.suspended) {
      return json({ error: "Administrator access required" }, 403);
    }

    // ---- 3. Parse and validate the target ----
    let body: { user_id?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Request body must be valid JSON with a user_id field" }, 400);
    }
    const targetId = body.user_id;
    if (!targetId || typeof targetId !== "string") {
      return json({ error: "user_id is required" }, 400);
    }
    if (targetId === user.id) {
      return json({ error: "You can't delete your own account through this tool" }, 400);
    }

    // ---- 4. Perform the privileged deletion with the service_role key ----
    // This key is only ever read here, on Supabase's servers — never
    // shipped to the browser.
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(targetId);
    if (deleteError) {
      return json({ error: deleteError.message }, 500);
    }

    return json({ success: true, deleted_user_id: targetId });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected server error" }, 500);
  }
});
