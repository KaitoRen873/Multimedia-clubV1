/* ============================================================
   Multimedia Club — Supabase configuration
   ------------------------------------------------------------
   1. Create a project at https://supabase.com (free tier is fine).
   2. In your project: Settings → API → copy the "Project URL"
      and the "anon public" key (NOT the service_role key — that
      one must never be shipped to a browser).
   3. Paste them below.
   4. Run supabase/schema.sql once in Settings → SQL Editor.
   That's it — no build step, no bundler required.
   ============================================================ */
const SUPABASE_URL = "https://wnqxywtgggqofbpzzcoz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InducXh5d3RnZ2dxb2ZicHp6Y296Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MDA2MzUsImV4cCI6MjA5ODQ3NjYzNX0.jqoCGYvhshHjUXBz1SMeuZKJ7psziNTKXAZxyb3j1JQ";

/* ============================================================
   Social media links
   ------------------------------------------------------------
   Paste your club's real profile URLs below. Any left as "" are
   simply not shown in the footer — no need to delete lines you're
   not using, just leave the value empty.
   ============================================================ */
const SOCIAL_LINKS = {
  instagram: "",   // e.g. "https://www.instagram.com/mshs.multimediaclub?igsh=MW82ODAzcmJ5ZHRxNQ=="
  facebook:  "",   // e.g. "https://www.facebook.com/profile.php?id=61591693935115"
};
