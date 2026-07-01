// Supabase Edge Function: delete-user
// ------------------------------------------------------------
// Deleting someone's login (not just their profile row) requires
// the service_role key, which must NEVER be shipped to a browser.
// This function runs on Supabase's servers, holds that key safely,
// and only allows an already-authenticated administrator to call it.
//
// Deploy with the Supabase CLI:
//   supabase functions deploy delete-user
//
// Call it from the browser like:
//   const { data, error } = await sb.functions.invoke('delete-user', {
//     body: { user_id: targetUserId }
//   });
//
// (This is optional for v1 — without it, the admin dashboard's
// "Delete" button still removes the member's profile data and blocks
// their app access via RLS, it just leaves the underlying login
// credentials in Supabase Auth until removed from the dashboard or
// this function is deployed.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    // Verify the caller's JWT and confirm they are an administrator,
    // using the ANON key + their own token (respects RLS).
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: { user }, error: authError } = await callerClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
    }
    const { data: callerProfile } = await callerClient
      .from("profiles")
      .select("account_type")
      .eq("id", user.id)
      .single();
    if (!callerProfile || callerProfile.account_type !== "administrator") {
      return new Response(JSON.stringify({ error: "Administrator access required" }), { status: 403 });
    }

    const { user_id } = await req.json();
    if (!user_id) {
      return new Response(JSON.stringify({ error: "user_id is required" }), { status: 400 });
    }

    // Now use the service_role key — only reachable from here, never
    // from the browser — to actually delete the auth account.
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(user_id);
    if (deleteError) {
      return new Response(JSON.stringify({ error: deleteError.message }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
});
