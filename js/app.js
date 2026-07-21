/* ============================================================
   Multimedia Club — application logic (v1, Supabase-backed)
   ------------------------------------------------------------
   This replaces the old in-memory mock DB with real Supabase
   tables, real Supabase Auth, and Realtime subscriptions. See
   supabase/schema.sql for the full backend definition and
   README.md for setup steps.
   ============================================================ */

/* ---------- defensive backend setup ----------
   If the Supabase SDK failed to load (CDN blocked, offline, ad
   blocker) or config.js still has placeholder keys, the rest of
   this file must NOT throw — a single uncaught error here would
   silently kill every function below it, including things that
   don't need a backend at all (theme toggle, nav, Solis's hidden
   keyboard shortcuts, etc). Instead we detect the problem, show it
   on-page, and keep the site itself usable. */
let backendReady = false;
let sb = null;

function backendMisconfigured(){
  return typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined'
    || !SUPABASE_URL || !SUPABASE_ANON_KEY
    || SUPABASE_URL.includes('YOUR-PROJECT-REF') || SUPABASE_ANON_KEY.includes('YOUR-ANON-PUBLIC-KEY');
}

function showBackendBanner(message){
  let banner = document.getElementById('backendWarningBanner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'backendWarningBanner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:3000;background:#fb7185;color:#1a0507;'
      + 'font-family:sans-serif;font-size:13px;padding:10px 16px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);';
    document.body.prepend(banner);
  }
  banner.textContent = message;
}

try {
  if(typeof window.supabase === 'undefined'){
    throw new Error('The Supabase SDK did not load. Check your internet connection, or that the <script> tag for @supabase/supabase-js in index.html loaded successfully (open your browser console for the exact network error).');
  }
  if(backendMisconfigured()){
    throw new Error('config.js still has placeholder values. Create a Supabase project, run supabase/schema.sql, then paste your real Project URL and anon key into config.js. See README.md.');
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  backendReady = true;
} catch (err) {
  console.error('[Multimedia Club] Backend not available:', err.message);
  document.addEventListener('DOMContentLoaded', ()=> showBackendBanner('⚠ ' + err.message));
}
function requireBackend(){
  if(!backendReady){ showBackendBanner('⚠ This needs a connected backend — see README.md for setup.'); return false; }
  return true;
}
function debounce(fn, wait){
  let t;
  return (...args)=>{ clearTimeout(t); t = setTimeout(()=> fn(...args), wait); };
}

const OFFICER_POSITIONS = [
  "President","Vice President","Secretary","Assistant Secretary","Treasurer","Assistant Treasurer",
  "Auditor","Public Information Officer (PIO)","Assistant PIO","Business Manager","Assistant Business Manager",
  "Grade Level Representative","Committee Head"
];
const ADMIN_SEAT_LIMIT = 2;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 20000;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;   // 15MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;  // 100MB — raise the bucket's own limit in Supabase if needed
const ALLOWED_MEDIA_TYPES = ['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime'];

/* ---------- local cache (kept in sync with Supabase via realtime) ---------- */
const cache = {
  profiles: [],
  announcements: [],
  events: [],
  news: [],
  media: [],
  collaborations: [],
  eventRequests: [],
  savedIds: new Set(),
  loginEvents: [],
};

let state = {
  currentUser: null,           // profile row of the signed-in user, or null
  mediaFilter: 'all',
  savedAnnouncements: [],      // announcement ids, mirrors cache.savedIds
  theme: 'dark',
  annFilter: {search:'', category:'all'},
  eventFilter: 'all',
  userFilter: {search:'', type:'all', status:'all'},
};

let loginAttempts = 0, loginLockedUntil = 0;
let adminLoginAttempts = 0, adminLoginLockedUntil = 0;
let suppressAutoLogin = false;
const notifications = [];
const presenceKey = crypto.randomUUID();
let presenceChannel = null;
let publishTab = 'announcement';

/* ---------- generic helpers ---------- */
function scrollToId(id){ document.getElementById(id).scrollIntoView({behavior:'smooth', block:'start'}); }
function formatDate(d){ return new Date(d).toLocaleDateString('en-US',{month:'short', day:'numeric'}); }
function formatFull(d){ return new Date(d).toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}) + ' at ' + new Date(d).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); }
function formatJoined(iso){ return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function isAdmin(){ return !!(state.currentUser && state.currentUser.account_type==='administrator'); }
function adminCount(){ return cache.profiles.filter(p=>p.account_type==='administrator' && !p.suspended).length; }
function detectDevice(){
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if(/Windows/.test(ua)) os='Windows'; else if(/Mac OS/.test(ua)) os='macOS';
  else if(/Android/.test(ua)) os='Android'; else if(/iPhone|iPad/.test(ua)) os='iOS';
  else if(/Linux/.test(ua)) os='Linux';
  let browser = 'Browser';
  if(/Edg\//.test(ua)) browser='Edge'; else if(/Chrome\//.test(ua)) browser='Chrome';
  else if(/Firefox\//.test(ua)) browser='Firefox'; else if(/Safari\//.test(ua)) browser='Safari';
  return `${browser} · ${os}`;
}
function nextEvent(){
  const upcoming = cache.events.filter(e=> new Date(e.event_date) > new Date()).sort((a,b)=> new Date(a.event_date)-new Date(b.event_date));
  return upcoming[0] || [...cache.events].sort((a,b)=> new Date(a.event_date)-new Date(b.event_date))[0];
}
function accountLabel(user){
  if(user.account_type==='administrator') return 'Administrator';
  return user.club_role ? `Member · ${user.club_role}` : 'Member';
}
function pushNotification(html){
  notifications.unshift({id:Date.now(), text:html, time:'just now'});
  if(notifications.length>8) notifications.pop();
  renderNotifications();
}

/* ============================================================
   INITIAL LOAD
   ============================================================ */
document.addEventListener('DOMContentLoaded', async () => {
  setupScrollReveal();
  setupKonamiListener();
  setupSolis();
  wireStaticControls();
  setInterval(tickCountdowns, 1000);

  if(!backendReady){
    // Static UI (theme toggle, Konami codes, Solis chat shell, scroll
    // effects) all still work without a backend. Data-backed sections
    // just render their empty states until config.js is set up.
    renderAnnouncements(); renderEvents(); renderNews(); renderMedia();
    return;
  }

  try {
    await Promise.all([fetchAnnouncements(), fetchEvents(), fetchNews(), fetchProfiles(), fetchMedia(), fetchCollaborations()]);
    renderAdminStats();
    logPageView();
    setupRealtimeSubscriptions();
    setupPresence();
    setInterval(()=>{ if(!document.getElementById('admin').classList.contains('hidden')){ renderAdminStats(); } }, 5000);
  } catch (err) {
    console.error('[Multimedia Club] Failed to load data from Supabase:', err);
    showBackendBanner('⚠ Connected to Supabase but a request failed — check your schema.sql has been run and your keys in config.js are correct. See browser console for details.');
  }
});

async function logPageView(){
  if(!backendReady) return;
  try{ await sb.from('page_views').insert({}); }catch(e){ /* non-critical */ }
}

/* ============================================================
   AUTH — real Supabase Auth
   ============================================================ */
if(backendReady){
  sb.auth.onAuthStateChange(async (event, session) => {
    if(suppressAutoLogin) return;
    if((event==='SIGNED_IN' || event==='INITIAL_SESSION') && session){
      const profile = await fetchOwnProfile(session.user.id);
      if(profile){
        if(profile.suspended){ await sb.auth.signOut(); return; }
        loginAs(profile);
      }
    } else if(event==='SIGNED_OUT'){
      logoutUi();
    }
  });
}

async function fetchOwnProfile(userId){
  const { data, error } = await sb.from('profiles').select('*').eq('id', userId).single();
  if(error){ console.error(error); return null; }
  return data;
}

function openAuth(tab){ document.getElementById('authBackdrop').classList.add('open'); switchAuthTab(tab||'login'); }
function closeAuth(){ document.getElementById('authBackdrop').classList.remove('open'); document.getElementById('authMsg').classList.remove('show'); }
document.getElementById('authBackdrop').addEventListener('click', e=>{ if(e.target.id==='authBackdrop') closeAuth(); });
function switchAuthTab(tab){
  document.getElementById('tabLogin').classList.toggle('active', tab==='login');
  document.getElementById('tabRegister').classList.toggle('active', tab==='register');
  document.getElementById('loginForm').classList.toggle('hidden', tab!=='login');
  document.getElementById('registerForm').classList.toggle('hidden', tab!=='register');
  document.getElementById('authMsg').classList.remove('show');
  if(tab!=='login') document.getElementById('resendConfirmRow').classList.add('hidden');
}
function showAuthMsg(text, type){ const el=document.getElementById('authMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleLogin(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const btn = document.getElementById('loginSubmitBtn');
  document.getElementById('resendConfirmRow').classList.add('hidden');
  if(Date.now() < loginLockedUntil){
    showAuthMsg(`Too many attempts. Try again in ${Math.ceil((loginLockedUntil-Date.now())/1000)}s.`, 'err');
    return;
  }
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;

  if(error){
    const isUnconfirmed = /confirm/i.test(error.message);
    if(isUnconfirmed){
      showAuthMsg('Your email address hasn\'t been confirmed yet. Check your inbox (and spam folder) for the confirmation link, or resend it below.', 'err');
      document.getElementById('resendConfirmRow').classList.remove('hidden');
      return;
    }
    loginAttempts++;
    if(loginAttempts>=MAX_LOGIN_ATTEMPTS){
      loginLockedUntil = Date.now()+LOCKOUT_MS; loginAttempts=0; btn.disabled=true;
      showAuthMsg(`Too many failed attempts. Locked for ${LOCKOUT_MS/1000}s.`, 'err');
      setTimeout(()=>{ btn.disabled=false; }, LOCKOUT_MS);
    } else {
      showAuthMsg(error.message || 'Incorrect email or password.', 'err');
    }
    return;
  }
  loginAttempts = 0;
  await recordLoginEvent(data.user.id);
  showAuthMsg('Welcome back!', 'ok');
  setTimeout(closeAuth, 600);
}

async function resendConfirmation(){
  if(!requireBackend()) return;
  const email = document.getElementById('loginEmail').value.trim();
  if(!email){ showAuthMsg('Enter your email above first, then resend the confirmation.', 'err'); return; }
  const link = document.getElementById('resendConfirmLink');
  link.textContent = 'Sending…';
  const { error } = await sb.auth.resend({ type: 'signup', email });
  link.textContent = 'Resend confirmation email';
  showAuthMsg(error ? error.message : 'Confirmation email resent — check your inbox (and spam folder).', error ? 'err' : 'ok');
}

async function handleRegister(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { name } }
  });
  if(error){
    if(/already registered|already exists|user already/i.test(error.message)){
      switchAuthTab('login');
      document.getElementById('loginEmail').value = email;
      showAuthMsg('An account with that email already exists. Log in below — if you never confirmed it, use "Resend confirmation email" after trying to log in.', 'err');
    } else {
      showAuthMsg(error.message, 'err');
    }
    return;
  }

  if(!data.session){
    showAuthMsg('Account created! Check your email to confirm before logging in.', 'ok');
    switchAuthTab('login');
    document.getElementById('loginEmail').value = email;
    return;
  }
  await recordLoginEvent(data.user.id);
  showAuthMsg('Welcome to the club!', 'ok');
  setTimeout(closeAuth, 700);
}

function forgotPassword(){
  if(!requireBackend()) return;
  const email = document.getElementById('loginEmail').value.trim();
  if(!email){ showAuthMsg('Enter your email above first, then click "Forgot password?".', 'err'); return; }
  sb.auth.resetPasswordForEmail(email).then(({error})=>{
    showAuthMsg(error ? error.message : 'Password reset email sent — check your inbox.', error?'err':'ok');
  });
}

async function recordLoginEvent(userId){
  try{
    await sb.from('login_events').insert({ user_id: userId, device: detectDevice() });
  }catch(e){ /* non-critical */ }
}

/* ---------- Administrator modal (hidden entrance) ---------- */
function openAdminAuth(){
  document.getElementById('adminAuthBackdrop').classList.add('open');
  document.getElementById('adminAuthMsg').classList.remove('show');
  setTimeout(()=> document.getElementById('adminLoginEmail')?.focus(), 100);
}
function closeAdminAuth(){ document.getElementById('adminAuthBackdrop').classList.remove('open'); }
document.getElementById('adminAuthBackdrop').addEventListener('click', e=>{ if(e.target.id==='adminAuthBackdrop') closeAdminAuth(); });
function showAdminAuthMsg(text, type){ const el=document.getElementById('adminAuthMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleAdminLogin(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const btn = document.getElementById('adminLoginSubmitBtn');
  if(Date.now() < adminLoginLockedUntil){
    showAdminAuthMsg(`Too many attempts. Try again in ${Math.ceil((adminLoginLockedUntil-Date.now())/1000)}s.`, 'err');
    return;
  }
  const email = document.getElementById('adminLoginEmail').value.trim();
  const password = document.getElementById('adminLoginPassword').value;

  suppressAutoLogin = true;
  btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;

  // The keyboard sequence only reveals this form — credentials are still
  // fully validated against Supabase Auth, and the account must actually
  // carry administrator privileges in the profiles table.
  if(error){
    suppressAutoLogin = false;
    adminLoginAttempts++;
    if(adminLoginAttempts>=MAX_LOGIN_ATTEMPTS){
      adminLoginLockedUntil = Date.now()+LOCKOUT_MS; adminLoginAttempts=0; btn.disabled=true;
      showAdminAuthMsg(`Too many failed attempts. Locked for ${LOCKOUT_MS/1000}s.`, 'err');
      setTimeout(()=>{ btn.disabled=false; }, LOCKOUT_MS);
    } else {
      showAdminAuthMsg('Invalid administrator credentials.', 'err');
    }
    return;
  }

  const profile = await fetchOwnProfile(data.user.id);
  if(!profile || profile.account_type!=='administrator' || profile.suspended){
    await sb.auth.signOut();
    suppressAutoLogin = false;
    showAdminAuthMsg('That account does not have administrator access.', 'err');
    return;
  }
  adminLoginAttempts = 0;
  suppressAutoLogin = false;
  await recordLoginEvent(profile.id);
  loginAs(profile);
  showAdminAuthMsg('Administrator access granted.', 'ok');
  setTimeout(closeAdminAuth, 600);
}

/* ---------- hidden keyboard sequences (Konami-style) ----------
   These ONLY reveal the relevant login form. They never grant
   access on their own — Supabase Auth always validates credentials. */
function setupKonamiListener(){
  const arrowMap = { ArrowUp:'U', ArrowDown:'D', ArrowLeft:'L', ArrowRight:'R' };
  const MEMBER_SEQ='UUUDRR', ADMIN_SEQ='DDLLU', EMERGENCY_SEQ='DDD';
  let buffer='';
  document.addEventListener('keydown', (e)=>{
    const tag = (e.target.tagName||'').toLowerCase();
    if(tag==='input' || tag==='textarea' || tag==='select') return;
    const key = arrowMap[e.key];
    if(!key) return;
    buffer += key;
    if(buffer.length>10) buffer = buffer.slice(-10);
    if(buffer.endsWith(MEMBER_SEQ)){ buffer=''; openAuth('login'); }
    else if(buffer.endsWith(ADMIN_SEQ)){ buffer=''; openAdminAuth(); }
    else if(buffer.endsWith(EMERGENCY_SEQ)){ buffer=''; openAdminAuth(); }
  });
}

/* ============================================================
   UI STATE: login / logout
   ============================================================ */
function loginAs(user){
  state.currentUser = user;
  pushNotification(`<b>Signed in</b> as ${escapeHtml(user.name)} · ${detectDevice()}`);
  document.getElementById('userMenuWrap').classList.remove('hidden');
  document.getElementById('userMenuWrap').style.display='flex';
  document.getElementById('userGreeting').textContent = user.name + ' · ' + accountLabel(user);
  document.getElementById('navDashboardLink').classList.remove('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('dashWelcome').textContent = 'Welcome back, '+user.name.split(' ')[0];
  if(user.account_type==='administrator'){
    document.getElementById('navAdminLink').classList.remove('hidden');
    document.getElementById('admin').classList.remove('hidden');
    fetchEventRequests();
    subscribeEventRequests();
  } else {
    document.getElementById('navAdminLink').classList.add('hidden');
    document.getElementById('admin').classList.add('hidden');
  }
  fetchSaved();
  renderDashboardProfile();
  renderDashboardNextEvent();
  renderAnnouncements();
  refreshMediaUploadUI();
  renderMedia();
  updateSolisStatusLine();
  if(presenceChannel) trackPresence();
  addSolisMsg(`Hey ${user.name.split(' ')[0]}! You're logged in as ${user.account_type==='administrator'?'an Administrator':'a Member'}. Want a quick tour of your dashboard${user.account_type==='administrator'?' or the admin panel':''}?`,
    { quickActions: user.account_type==='administrator'
        ? [{label:'Open dashboard', style:'safe', action:'go_dashboard'},{label:'Open admin panel', style:'safe', action:'go_admin'}]
        : [{label:'Open dashboard', style:'safe', action:'go_dashboard'}] });
}
function logoutUi(){
  state.currentUser = null;
  cache.savedIds = new Set();
  cache.eventRequests = [];
  unsubscribeEventRequests();
  document.getElementById('userMenuWrap').classList.add('hidden');
  document.getElementById('navDashboardLink').classList.add('hidden');
  document.getElementById('navAdminLink').classList.add('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('admin').classList.add('hidden');
  updateSolisStatusLine();
  renderAnnouncements();
  refreshMediaUploadUI();
  renderMedia();
  if(presenceChannel) trackPresence();
}
document.getElementById('logoutBtn').addEventListener('click', async ()=>{ if(!requireBackend()) return; await sb.auth.signOut(); scrollToId('home'); });

/* ============================================================
   DATA FETCHING
   ============================================================ */
async function fetchAnnouncements(){
  const { data, error } = await sb.from('announcements').select('*').order('pinned',{ascending:false}).order('created_at',{ascending:false});
  if(!error) cache.announcements = data;
  renderAnnouncements();
  updateHeroWidgets();
}
async function fetchEvents(){
  const { data, error } = await sb.from('events').select('*').order('event_date',{ascending:true});
  if(!error) cache.events = data;
  renderEvents();
  updateHeroWidgets();
}
async function fetchNews(){
  const { data, error } = await sb.from('news').select('*').order('created_at',{ascending:false});
  if(!error) cache.news = data;
  renderNews();
}
async function fetchMedia(){
  const { data, error } = await sb.from('media_posts').select('*').order('created_at',{ascending:false});
  if(!error) cache.media = data;
  renderMedia();
}
async function fetchCollaborations(){
  const { data, error } = await sb.from('collaborations').select('*').order('created_at',{ascending:false});
  if(!error) cache.collaborations = data;
  renderCollabGrid();
  if(state.currentUser) populateMediaLinkOptions();
}
async function fetchEventRequests(){
  if(!isAdmin()) return; // RLS would return nothing anyway; skip the call
  const { data, error } = await sb.from('event_requests').select('*').order('created_at',{ascending:false});
  if(!error) cache.eventRequests = data;
  renderEventRequestsTable();
}
async function fetchProfiles(){
  const { data, error } = await sb.from('profiles').select('*').order('created_at',{ascending:true});
  if(!error) cache.profiles = data;
  if(isAdmin()){ renderAdminUsers(); renderAdminStats(); }
}
async function fetchSaved(){
  if(!state.currentUser) return;
  const { data, error } = await sb.from('saved_announcements').select('announcement_id').eq('user_id', state.currentUser.id);
  if(!error){
    cache.savedIds = new Set(data.map(r=>r.announcement_id));
    state.savedAnnouncements = [...cache.savedIds];
  }
  renderAnnouncements();
  renderDashboardSaved();
  renderDashboardActivity();
}
async function fetchLoginMonitor(){
  const { data, error } = await sb.from('login_events').select('id, device, created_at, profiles(name)').order('created_at',{ascending:false}).limit(12);
  if(!error) cache.loginEvents = data;
  renderLoginMonitor();
}
async function fetchAuditLog(){
  const { data, error } = await sb.from('audit_log').select('id, action, detail, created_at').order('created_at',{ascending:false}).limit(14);
  if(!error) renderAdminActivity(data||[]);
}

function setupRealtimeSubscriptions(){
  const debouncedAnnouncements = debounce(fetchAnnouncements, 400);
  const debouncedEvents = debounce(fetchEvents, 400);
  const debouncedNews = debounce(fetchNews, 400);
  const debouncedProfiles = debounce(fetchProfiles, 400);
  const debouncedMedia = debounce(fetchMedia, 400);
  const debouncedCollaborations = debounce(fetchCollaborations, 400);

  sb.channel('public:media_posts')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'media_posts'}, (payload)=>{
      if(!state.currentUser || payload.new.uploader_id !== state.currentUser.id){
        pushNotification(`<b>${escapeHtml(payload.new.uploader_name)}</b> shared a new ${payload.new.media_type}.`);
      }
      debouncedMedia();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'media_posts'}, debouncedMedia)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'media_posts'}, debouncedMedia)
    .subscribe();

  sb.channel('public:collaborations')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'collaborations'}, (payload)=>{
      pushNotification(`<b>New collaboration:</b> ${escapeHtml(payload.new.title)} with ${escapeHtml(payload.new.partner_club)}`);
      debouncedCollaborations();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'collaborations'}, debouncedCollaborations)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'collaborations'}, debouncedCollaborations)
    .subscribe();

  sb.channel('public:announcements')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'announcements'}, (payload)=>{
      pushNotification(`<b>New announcement:</b> ${escapeHtml(payload.new.title)}`);
      debouncedAnnouncements();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'announcements'}, debouncedAnnouncements)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'announcements'}, debouncedAnnouncements)
    .subscribe();

  sb.channel('public:events')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'events'}, (payload)=>{
      pushNotification(`<b>New event:</b> ${escapeHtml(payload.new.title)} — ${formatDate(payload.new.event_date)}`);
      debouncedEvents();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'events'}, debouncedEvents)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'events'}, debouncedEvents)
    .subscribe();

  sb.channel('public:news')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'news'}, (payload)=>{
      pushNotification(`<b>New story:</b> ${escapeHtml(payload.new.title)}`);
      debouncedNews();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'news'}, debouncedNews)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'news'}, debouncedNews)
    .subscribe();

  sb.channel('public:profiles').on('postgres_changes', {event:'*', schema:'public', table:'profiles'}, async (payload)=>{
    debouncedProfiles();
    if(state.currentUser && payload.new && payload.new.id===state.currentUser.id){
      if(payload.new.suspended){ await sb.auth.signOut(); return; }
      const roleChanged = payload.old && (
        payload.old.account_type !== payload.new.account_type ||
        payload.old.club_role !== payload.new.club_role ||
        payload.old.officer !== payload.new.officer
      );
      state.currentUser = payload.new;
      document.getElementById('userGreeting').textContent = payload.new.name + ' · ' + accountLabel(payload.new);
      renderDashboardProfile();
      if(roleChanged) pushNotification(`<b>Your account was updated:</b> you're now ${accountLabel(payload.new)}.`);
    }
  }).subscribe();

  checkUpcomingEventReminders();
  setInterval(checkUpcomingEventReminders, 5*60*1000);
}

const remindedEventIds = new Set();
function checkUpcomingEventReminders(){
  const now = new Date();
  cache.events.forEach(ev=>{
    const diffHrs = (new Date(ev.event_date) - now) / 3600000;
    if(diffHrs > 0 && diffHrs <= 24 && !remindedEventIds.has(ev.id)){
      remindedEventIds.add(ev.id);
      pushNotification(`<b>Event reminder:</b> ${escapeHtml(ev.title)} is coming up within 24 hours.`);
    }
  });
}

const debouncedAdminStatsRefresh = debounce(()=>{
  // Presence 'sync' fires for every visitor joining/leaving the whole
  // site, for every connected client — not just admins. Re-querying
  // the database on each one is wasted work for anyone not looking at
  // the admin panel, and a real source of lag when several people are
  // browsing at once.
  if(document.getElementById('admin').classList.contains('hidden')) return;
  renderAdminStats();
}, 1200);

function setupPresence(){
  presenceChannel = sb.channel('site-presence', { config: { presence: { key: presenceKey } } });
  presenceChannel
    .on('presence', {event:'sync'}, ()=>{
      updateHeroWidgets(); // cheap, local-only — keep this instant
      debouncedAdminStatsRefresh();
    })
    .subscribe((status)=>{ if(status==='SUBSCRIBED') trackPresence(); });
}
function trackPresence(){
  if(!presenceChannel) return;
  presenceChannel.track({
    user_id: state.currentUser ? state.currentUser.id : null,
    name: state.currentUser ? state.currentUser.name : 'Guest',
    account_type: state.currentUser ? state.currentUser.account_type : null,
  });
}
function presenceOnlineIds(){
  if(!presenceChannel) return new Set();
  const st = presenceChannel.presenceState();
  const ids = new Set();
  Object.values(st).forEach(arr=> arr.forEach(p=>{ if(p.user_id) ids.add(p.user_id); }));
  return ids;
}
function presenceCount(){
  if(!presenceChannel) return 0;
  return Object.keys(presenceChannel.presenceState()).length;
}

/* ============================================================
   RENDERING — Announcements
   ============================================================ */
function renderAnnouncements(){
  const grid = document.getElementById('annGrid');
  const f = state.annFilter;
  let list = cache.announcements.filter(a=>{
    const matchCat = f.category==='all' || a.category===f.category;
    const matchSearch = !f.search || (a.title+a.body).toLowerCase().includes(f.search.toLowerCase());
    return matchCat && matchSearch;
  });
  grid.innerHTML = list.length ? list.map(a=>`
    <div class="card glass ${a.pinned?'pinned':''}">
      <span class="tag ${a.category}">${a.category}</span>
      <h3>${escapeHtml(a.title)}</h3>
      <p>${escapeHtml(a.body)}</p>
      <div class="card-meta"><span>${escapeHtml(a.author)}</span><span>${formatDate(a.created_at)}</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-ghost btn" style="padding:6px 10px;font-size:12px;" onclick="toggleSave(${a.id}, this)">
          ${cache.savedIds.has(a.id) ? '★ Saved' : '☆ Save'}
        </button>
        ${isAdmin() ? `
          <button class="btn-ghost btn" style="padding:6px 10px;font-size:12px;" onclick="togglePin(${a.id}, ${a.pinned})">${a.pinned?'Unpin':'Pin'}</button>
          <button class="btn-ghost btn" style="padding:6px 10px;font-size:12px;color:var(--rose);" onclick="deleteAnnouncement(${a.id})">Delete</button>
        ` : ''}
      </div>
    </div>
  `).join('') : `<div class="empty-state">No announcements match your search — try a different keyword or category.</div>`;
}
document.getElementById('annSearch').addEventListener('input', debounce(e=>{ state.annFilter.search=e.target.value; renderAnnouncements(); }, 180));
document.getElementById('annCategory').addEventListener('change', e=>{ state.annFilter.category=e.target.value; renderAnnouncements(); });

async function toggleSave(id){
  if(!requireBackend()) return;
  if(!state.currentUser){ openAuth('login'); return; }
  if(cache.savedIds.has(id)){
    await sb.from('saved_announcements').delete().eq('user_id', state.currentUser.id).eq('announcement_id', id);
    cache.savedIds.delete(id);
  } else {
    await sb.from('saved_announcements').insert({ user_id: state.currentUser.id, announcement_id: id });
    cache.savedIds.add(id);
  }
  state.savedAnnouncements = [...cache.savedIds];
  renderAnnouncements();
  renderDashboardSaved();
}
async function togglePin(id, currentlyPinned){
  if(!requireBackend()) return;
  const { error } = await sb.from('announcements').update({pinned: !currentlyPinned}).eq('id', id);
  if(!error) writeAudit('pin_toggle', null, `Announcement #${id} pinned=${!currentlyPinned}`);
}
async function deleteAnnouncement(id){
  if(!requireBackend()) return;
  const { error } = await sb.from('announcements').delete().eq('id', id);
  if(!error) writeAudit('delete_announcement', null, `Deleted announcement #${id}`);
}

function renderDashboardSaved(){
  const wrap = document.getElementById('dashSaved');
  const count = document.getElementById('savedCount');
  count.textContent = cache.savedIds.size;
  if(!cache.savedIds.size){ wrap.innerHTML = `<div class="empty-state">Pin the ★ on any announcement to save it here.</div>`; return; }
  wrap.innerHTML = [...cache.savedIds].map(id=>{
    const a = cache.announcements.find(x=>x.id===id);
    if(!a) return '';
    return `<div class="activity-item"><div class="avatar"></div><div class="txt">${escapeHtml(a.title)}</div></div>`;
  }).join('');
}
function renderDashboardActivity(){
  const items = [
    {t:'Signed in to Multimedia Club', time:'just now'},
    {t: cache.savedIds.size ? `${cache.savedIds.size} saved announcement${cache.savedIds.size!==1?'s':''}` : 'No saved announcements yet', time:''},
  ];
  document.getElementById('dashActivity').innerHTML = items.map(i=>`
    <div class="activity-item"><div class="avatar"></div><div class="txt">${i.t}</div><div class="time">${i.time}</div></div>
  `).join('');
}
function renderDashboardNextEvent(){
  const ev = nextEvent();
  document.getElementById('dashNextEvent').innerHTML = ev ? `<b>${escapeHtml(ev.title)}</b><br>${formatDate(ev.event_date)} · ${escapeHtml(ev.location)}` : 'No upcoming events.';
}
function renderDashboardProfile(){
  const u = state.currentUser;
  const wrap = document.getElementById('dashProfile');
  if(!wrap || !u) return;
  const badges = [`<span class="role-badge ${u.account_type}">${u.account_type==='administrator'?'Administrator':'Member'}</span>`];
  if(u.club_role) badges.push(`<span class="role-badge ${u.club_role.toLowerCase()}">${u.club_role}</span>`);
  if(u.officer) badges.push(`<span class="role-badge officer">★ ${u.officer}</span>`);
  wrap.innerHTML = badges.join('');
}

/* ============================================================
   RENDERING — Events
   ============================================================ */
function renderEvents(){
  const chipsWrap = document.getElementById('eventFilterChips');
  const cats = ['all','academics','sports','arts','general'];
  chipsWrap.innerHTML = cats.map(c=>`<button class="chip ${state.eventFilter===c?'active':''}" onclick="setEventFilter('${c}')">${c[0].toUpperCase()+c.slice(1)}</button>`).join('');

  const list = document.getElementById('eventsList');
  let events = cache.events.filter(e=> state.eventFilter==='all' || e.category===state.eventFilter);
  list.innerHTML = events.length ? events.map(e=>{
    const d = new Date(e.event_date);
    return `
    <div class="event-row glass" data-event-id="${e.id}">
      <div class="event-date"><div class="d">${d.getDate()}</div><div class="m">${d.toLocaleString('en-US',{month:'short'})}</div></div>
      <div class="event-info">
        <h4>${escapeHtml(e.title)}</h4>
        <p>${escapeHtml(e.location)} · ${escapeHtml(e.description||'')}</p>
      </div>
      <div class="countdown" id="countdown-${e.id}"></div>
      ${isAdmin() ? `<button class="mini-btn danger" style="margin-left:10px;" onclick="deleteEvent(${e.id})">Delete</button>` : ''}
    </div>`;
  }).join('') : `<div class="empty-state">No events in this category right now.</div>`;
  tickCountdowns();
}
function setEventFilter(c){ state.eventFilter=c; renderEvents(); }
async function deleteEvent(id){
  if(!requireBackend()) return;
  const { error } = await sb.from('events').delete().eq('id', id);
  if(!error) writeAudit('delete_event', null, `Deleted event #${id}`);
}
function tickCountdowns(){
  cache.events.forEach(e=>{
    const el = document.getElementById('countdown-'+e.id);
    if(!el) return;
    const diff = new Date(e.event_date) - new Date();
    if(diff<=0){ el.innerHTML = `<span class="mono" style="color:var(--text-2);font-size:12px;">event live/past</span>`; return; }
    const d=Math.floor(diff/86400000), h=Math.floor(diff%86400000/3600000), m=Math.floor(diff%3600000/60000), s=Math.floor(diff%60000/1000);
    el.innerHTML = `<div class="u"><div class="n">${d}</div><div class="l">days</div></div><div class="u"><div class="n">${h}</div><div class="l">hrs</div></div><div class="u"><div class="n">${m}</div><div class="l">min</div></div><div class="u"><div class="n">${s}</div><div class="l">sec</div></div>`;
  });
}
function updateHeroWidgets(){
  const upcoming = nextEvent();
  document.getElementById('heroNextEvent').textContent = upcoming ? upcoming.title.split(' ').slice(0,3).join(' ') : '—';
  document.getElementById('heroLiveUsers').textContent = presenceCount() || '—';
  const today = new Date(); today.setHours(0,0,0,0);
  document.getElementById('heroNewPosts').textContent = cache.announcements.filter(a=> new Date(a.created_at) >= today).length;
}

/* ============================================================
   RENDERING — News
   ============================================================ */
function renderNews(search=''){
  const wrap = document.getElementById('newsCarousel');
  const list = cache.news.filter(n=> !search || (n.title+n.body).toLowerCase().includes(search.toLowerCase()));
  wrap.innerHTML = list.length ? list.map(n=>`
    <div class="news-card glass">
      <div class="news-thumb">${n.icon||'📰'}</div>
      <span class="tag general">${escapeHtml(n.category)}</span>
      <h3 style="margin-top:8px;">${escapeHtml(n.title)}</h3>
      <p>${escapeHtml(n.body)}</p>
    </div>
  `).join('') : `<div class="empty-state">No stories found.</div>`;
}
document.getElementById('newsSearch').addEventListener('input', debounce(e=> renderNews(e.target.value), 180));

/* ============================================================
   MEDIA / COLLABORATIONS — members share photos & videos for
   events, announcements, or club collaborations
   ============================================================ */
function renderCollabGrid(){
  const grid = document.getElementById('collabGrid');
  if(!grid) return;
  grid.innerHTML = cache.collaborations.length ? cache.collaborations.map(c=>`
    <div class="card glass">
      <span class="tag general">${escapeHtml(c.partner_club)}</span>
      <h3>${escapeHtml(c.title)}</h3>
      ${c.description ? `<p>${escapeHtml(c.description)}</p>` : ''}
      <div class="card-meta">
        <span>${c.collab_date ? formatDate(c.collab_date) : 'Ongoing'}</span>
        <span>${formatDate(c.created_at)}</span>
      </div>
      ${isAdmin() ? `<button class="btn-ghost btn" style="align-self:flex-start;padding:6px 10px;font-size:12px;color:var(--rose);" onclick="deleteCollaboration(${c.id})">Delete</button>` : ''}
    </div>
  `).join('') : `<div class="empty-state">No collaborations posted yet.</div>`;
}
async function deleteCollaboration(id){
  if(!requireBackend()) return;
  if(!confirm('Delete this collaboration listing?')) return;
  const { error } = await sb.from('collaborations').delete().eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('delete_collaboration', null, `Deleted collaboration #${id}`);
}

/* ============================================================
   EVENT REQUESTS — other clubs ask to have their event posted
   ============================================================ */
function showEventRequestMsg(text, type){
  const el = document.getElementById('erFormMsg');
  el.textContent = text; el.className = 'form-msg show '+type;
}
async function handleEventRequestSubmit(e){
  e.preventDefault();
  if(!requireBackend()) return;
  const btn = document.getElementById('erSubmitBtn');
  const clubName = document.getElementById('erClubInput').value.trim();
  const eventTitle = document.getElementById('erTitleInput').value.trim();
  const contactName = document.getElementById('erContactNameInput').value.trim();
  const contactEmail = document.getElementById('erContactEmailInput').value.trim();
  const proposedDate = document.getElementById('erDateInput').value;
  const location = document.getElementById('erLocationInput').value.trim();
  const description = document.getElementById('erDescInput').value.trim();

  btn.disabled = true; btn.textContent = 'Submitting…';
  const { error } = await sb.from('event_requests').insert({
    club_name: clubName,
    contact_name: contactName,
    contact_email: contactEmail,
    event_title: eventTitle,
    description: description || null,
    proposed_date: proposedDate ? new Date(proposedDate).toISOString() : null,
    location: location || null,
  });
  btn.disabled = false; btn.textContent = 'Submit request';

  if(error){ showEventRequestMsg(error.message, 'err'); return; }
  showEventRequestMsg("Thanks! We've got it — an officer will review your request and reach out if needed.", 'ok');
  e.target.reset();
}

function renderEventRequestsTable(){
  const tbody = document.getElementById('eventRequestsTbody');
  if(!tbody) return;
  const pending = cache.eventRequests.filter(r=>r.status==='Pending').length;
  const chip = document.getElementById('erPendingChip');
  if(chip) chip.textContent = `${pending} pending`;

  tbody.innerHTML = cache.eventRequests.length ? cache.eventRequests.map(r=>`
    <tr>
      <td><b>${escapeHtml(r.club_name)}</b></td>
      <td>${escapeHtml(r.event_title)}${r.location?`<br><span style="color:var(--text-2);font-size:11px;">${escapeHtml(r.location)}</span>`:''}</td>
      <td>${escapeHtml(r.contact_name)}<br><span style="color:var(--text-2);font-size:11px;">${escapeHtml(r.contact_email)}</span></td>
      <td class="mono" style="font-size:11px;">${r.proposed_date ? formatDate(r.proposed_date) : '—'}</td>
      <td><span class="role-badge ${r.status==='Approved'?'member':(r.status==='Declined'?'none':'officer')}">${r.status}</span></td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        ${r.status==='Pending' ? `
          <button class="mini-btn" onclick="approveEventRequest(${r.id})">Approve &amp; post</button>
          <button class="mini-btn danger" onclick="declineEventRequest(${r.id})">Decline</button>
        ` : `<button class="mini-btn danger" onclick="deleteEventRequest(${r.id})">Remove</button>`}
      </td>
    </tr>
  `).join('') : `<tr><td colspan="6"><div class="empty-state">No requests from other clubs yet.</div></td></tr>`;
}

async function approveEventRequest(id){
  if(!requireBackend()) return;
  const req = cache.eventRequests.find(r=>r.id===id);
  if(!req) return;
  if(!confirm(`Post "${req.event_title}" to the Events page and mark this request approved?`)) return;

  const { data: newEvent, error: insertError } = await sb.from('events').insert({
    title: req.event_title,
    event_date: req.proposed_date || new Date(Date.now()+7*86400000).toISOString(),
    category: 'general',
    location: req.location || 'TBA',
    description: (req.description ? req.description+' ' : '') + `(Submitted by ${req.club_name})`,
    created_by: state.currentUser.id,
  }).select().single();
  if(insertError){ alert(insertError.message); return; }

  const { error: updateError } = await sb.from('event_requests').update({
    status: 'Approved', reviewed_by: state.currentUser.id, created_event_id: newEvent.id,
  }).eq('id', id);
  if(updateError){ alert(updateError.message); return; }

  writeAudit('approve_event_request', null, `${req.event_title} (${req.club_name})`);
  fetchEvents();
}
async function declineEventRequest(id){
  if(!requireBackend()) return;
  const req = cache.eventRequests.find(r=>r.id===id);
  if(!confirm('Decline this event request?')) return;
  const { error } = await sb.from('event_requests').update({
    status: 'Declined', reviewed_by: state.currentUser.id,
  }).eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('decline_event_request', null, req ? `${req.event_title} (${req.club_name})` : `#${id}`);
}
async function deleteEventRequest(id){
  if(!requireBackend()) return;
  if(!confirm('Remove this request from the list?')) return;
  const { error } = await sb.from('event_requests').delete().eq('id', id);
  if(error){ alert(error.message); return; }
}

let eventRequestsChannel = null;
function subscribeEventRequests(){
  if(eventRequestsChannel) return; // already subscribed
  const debouncedRefresh = debounce(fetchEventRequests, 400);
  eventRequestsChannel = sb.channel('public:event_requests')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'event_requests'}, (payload)=>{
      pushNotification(`<b>New event request:</b> ${escapeHtml(payload.new.club_name)} — ${escapeHtml(payload.new.event_title)}`);
      debouncedRefresh();
    })
    .on('postgres_changes', {event:'UPDATE', schema:'public', table:'event_requests'}, debouncedRefresh)
    .on('postgres_changes', {event:'DELETE', schema:'public', table:'event_requests'}, debouncedRefresh)
    .subscribe();
}
function unsubscribeEventRequests(){
  if(eventRequestsChannel){ sb.removeChannel(eventRequestsChannel); eventRequestsChannel = null; }
}


function renderMedia(){
  const chipsWrap = document.getElementById('mediaFilterChips');
  const cats = [['all','All'],['event','Events'],['announcement','Announcements'],['collaboration','Collaborations']];
  chipsWrap.innerHTML = cats.map(([v,label])=>`<button class="chip ${state.mediaFilter===v?'active':''}" onclick="setMediaFilter('${v}')">${label}</button>`).join('');

  const grid = document.getElementById('mediaGrid');
  const list = cache.media.filter(m=> state.mediaFilter==='all' || m.category===state.mediaFilter);

  grid.innerHTML = list.length ? list.map(m=>{
    const canManage = state.currentUser && (state.currentUser.id===m.uploader_id || isAdmin());
    let linkedHtml = '';
    if(m.category==='event' && m.event_id){
      const ev = cache.events.find(e=>e.id===m.event_id);
      if(ev) linkedHtml = `<div class="media-linked">For event: <a href="#events" onclick="scrollToId('events')">${escapeHtml(ev.title)}</a></div>`;
    } else if(m.category==='announcement' && m.announcement_id){
      const a = cache.announcements.find(x=>x.id===m.announcement_id);
      if(a) linkedHtml = `<div class="media-linked">For announcement: <a href="#announcements" onclick="scrollToId('announcements')">${escapeHtml(a.title)}</a></div>`;
    } else if(m.category==='collaboration' && m.collaboration_id){
      const c = cache.collaborations.find(x=>x.id===m.collaboration_id);
      if(c) linkedHtml = `<div class="media-linked">For collaboration: <a href="#collaborations" onclick="scrollToId('collaborations')">${escapeHtml(c.title)}</a></div>`;
    }
    return `
    <div class="media-card glass">
      <div class="media-thumb">
        ${m.media_type==='video'
          ? `<video src="${m.media_url}" controls preload="metadata"></video>`
          : `<img src="${m.media_url}" alt="${escapeHtml(m.caption||'Shared media')}" loading="lazy" />`}
      </div>
      ${m.caption ? `<div class="media-caption">${escapeHtml(m.caption)}</div>` : ''}
      ${linkedHtml}
      <div class="media-meta">
        <span>${escapeHtml(m.uploader_name)}</span>
        <span>${formatDate(m.created_at)}</span>
      </div>
      ${canManage ? `<button class="mini-btn danger" onclick="deleteMedia(${m.id}, '${m.storage_path}')">Delete</button>` : ''}
    </div>`;
  }).join('') : `<div class="empty-state">No media shared yet — be the first to post something.</div>`;
}
function setMediaFilter(v){ state.mediaFilter = v; renderMedia(); }

function refreshMediaUploadUI(){
  const canPost = !!state.currentUser;
  document.getElementById('mediaUploadWrap').classList.toggle('hidden', !canPost);
  document.getElementById('mediaLoginPrompt').classList.toggle('hidden', canPost);
  if(canPost) populateMediaLinkOptions();
}
function populateMediaLinkOptions(){
  const evSel = document.getElementById('mediaEventInput');
  evSel.innerHTML = cache.events.map(e=>`<option value="${e.id}">${escapeHtml(e.title)}</option>`).join('') || '<option value="">No events yet</option>';
  const annSel = document.getElementById('mediaAnnInput');
  annSel.innerHTML = cache.announcements.map(a=>`<option value="${a.id}">${escapeHtml(a.title)}</option>`).join('') || '<option value="">No announcements yet</option>';
  const collabSel = document.getElementById('mediaCollabInput');
  collabSel.innerHTML = '<option value="">General / not a specific one</option>'
    + cache.collaborations.map(c=>`<option value="${c.id}">${escapeHtml(c.title)} (${escapeHtml(c.partner_club)})</option>`).join('');
}
function onMediaCategoryChange(){
  const cat = document.getElementById('mediaCategoryInput').value;
  document.getElementById('mediaEventPickWrap').classList.toggle('hidden', cat!=='event');
  document.getElementById('mediaAnnPickWrap').classList.toggle('hidden', cat!=='announcement');
  document.getElementById('mediaCollabPickWrap').classList.toggle('hidden', cat!=='collaboration');
}
function showMediaMsg(text, type){ const el=document.getElementById('mediaMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleMediaUpload(e){
  e.preventDefault();
  if(!requireBackend()) return;
  if(!state.currentUser){ showMediaMsg('Log in first to share media.', 'err'); return; }

  const fileInput = document.getElementById('mediaFileInput');
  const file = fileInput.files[0];
  if(!file){ showMediaMsg('Choose a photo or video file first.', 'err'); return; }
  if(!ALLOWED_MEDIA_TYPES.includes(file.type)){
    showMediaMsg('That file type isn\'t supported. Use JPG, PNG, WEBP, GIF, MP4, WEBM, or MOV.', 'err');
    return;
  }
  const isVideo = file.type.startsWith('video/');
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if(file.size > maxBytes){
    showMediaMsg(`That file is too large — max ${Math.round(maxBytes/1024/1024)}MB for ${isVideo?'video':'images'}.`, 'err');
    return;
  }

  const category = document.getElementById('mediaCategoryInput').value;
  const caption = document.getElementById('mediaCaptionInput').value.trim();
  const eventId = category==='event' ? (document.getElementById('mediaEventInput').value || null) : null;
  const announcementId = category==='announcement' ? (document.getElementById('mediaAnnInput').value || null) : null;
  const collaborationId = category==='collaboration' ? (document.getElementById('mediaCollabInput').value || null) : null;

  const btn = document.getElementById('mediaSubmitBtn');
  btn.disabled = true;
  showMediaMsg('Uploading…', 'ok');

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${state.currentUser.id}/${Date.now()}_${safeName}`;

  const { error: uploadError } = await sb.storage.from('media').upload(storagePath, file);
  if(uploadError){
    btn.disabled = false;
    showMediaMsg(uploadError.message, 'err');
    return;
  }
  const { data: urlData } = sb.storage.from('media').getPublicUrl(storagePath);

  const { error: insertError } = await sb.from('media_posts').insert({
    uploader_id: state.currentUser.id,
    uploader_name: state.currentUser.name,
    category,
    event_id: eventId,
    announcement_id: announcementId,
    collaboration_id: collaborationId,
    caption: caption || null,
    storage_path: storagePath,
    media_url: urlData.publicUrl,
    media_type: isVideo ? 'video' : 'image',
  });
  btn.disabled = false;

  if(insertError){
    // Clean up the uploaded file if the DB row failed, so it doesn't
    // sit orphaned in storage with nothing pointing to it.
    await sb.storage.from('media').remove([storagePath]);
    showMediaMsg(insertError.message, 'err');
    return;
  }
  showMediaMsg('Uploaded! Thanks for sharing.', 'ok');
  e.target.reset();
  onMediaCategoryChange();
}

async function deleteMedia(id, storagePath){
  if(!requireBackend()) return;
  if(!confirm('Remove this photo/video?')) return;
  await sb.storage.from('media').remove([storagePath]);
  const { error } = await sb.from('media_posts').delete().eq('id', id);
  if(error){ alert(error.message); return; }
}

/* ============================================================
   ADMIN — publish content
   ============================================================ */
function switchPublishTab(tab){
  publishTab = tab;
  document.getElementById('publishTabAnn').classList.toggle('active', tab==='announcement');
  document.getElementById('publishTabEvent').classList.toggle('active', tab==='event');
  document.getElementById('publishTabCollab').classList.toggle('active', tab==='collaboration');
  document.getElementById('announcementForm').classList.toggle('hidden', tab!=='announcement');
  document.getElementById('eventForm').classList.toggle('hidden', tab!=='event');
  document.getElementById('collabForm').classList.toggle('hidden', tab!=='collaboration');
}
function showPublishMsg(text, type){ const el=document.getElementById('publishMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleCreateAnnouncement(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const title = document.getElementById('annTitleInput').value.trim();
  const body = document.getElementById('annBodyInput').value.trim();
  const category = document.getElementById('annCategoryInput').value;
  const pinned = document.getElementById('annPinnedInput').checked;
  const { error } = await sb.from('announcements').insert({
    title, body, category, pinned, author: state.currentUser.name, created_by: state.currentUser.id
  });
  if(error){ showPublishMsg(error.message, 'err'); return; }
  writeAudit('create_announcement', null, title);
  showPublishMsg('Announcement published.', 'ok');
  e.target.reset();
}
async function handleCreateEvent(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const title = document.getElementById('evTitleInput').value.trim();
  const date = document.getElementById('evDateInput').value;
  const category = document.getElementById('evCategoryInput').value;
  const location = document.getElementById('evLocationInput').value.trim();
  const description = document.getElementById('evDescInput').value.trim();
  const { error } = await sb.from('events').insert({
    title, event_date: new Date(date).toISOString(), category, location, description, created_by: state.currentUser.id
  });
  if(error){ showPublishMsg(error.message, 'err'); return; }
  writeAudit('create_event', null, title);
  showPublishMsg('Event published.', 'ok');
  e.target.reset();
}
async function handleCreateCollaboration(e){
  if(!requireBackend()) return;
  e.preventDefault();
  const title = document.getElementById('collabTitleInput').value.trim();
  const partnerClub = document.getElementById('collabPartnerInput').value.trim();
  const description = document.getElementById('collabDescInput').value.trim();
  const date = document.getElementById('collabDateInput').value;
  const { error } = await sb.from('collaborations').insert({
    title, partner_club: partnerClub, description: description || null,
    collab_date: date ? new Date(date).toISOString() : null,
    created_by: state.currentUser.id
  });
  if(error){ showPublishMsg(error.message, 'err'); return; }
  writeAudit('create_collaboration', null, `${title} (${partnerClub})`);
  showPublishMsg('Collaboration published.', 'ok');
  e.target.reset();
}

/* ============================================================
   ADMIN — member management
   ============================================================ */
function officerOptionsHtml(selected){
  return '<option value="">— none —</option>' + OFFICER_POSITIONS.map(p=>`<option value="${p}" ${selected===p?'selected':''}>${p}</option>`).join('');
}
function renderAdminUsers(){
  const tbody = document.getElementById('userTableBody');
  const f = state.userFilter;
  const onlineIds = presenceOnlineIds();
  const list = cache.profiles.filter(u=>{
    const matchSearch = !f.search || (u.name+u.email).toLowerCase().includes(f.search.toLowerCase());
    const matchType = f.type==='all' || u.account_type===f.type;
    const online = onlineIds.has(u.id);
    const matchStatus = f.status==='all' || (f.status==='suspended' ? u.suspended : (!u.suspended && (f.status==='online'?online:!online)));
    return matchSearch && matchType && matchStatus;
  });
  tbody.innerHTML = list.length ? list.map(u=>{
    const online = onlineIds.has(u.id);
    return `
    <tr data-uid="${u.id}">
      <td><b>${escapeHtml(u.name)}</b><br><span style="color:var(--text-2);font-size:11.5px;">${escapeHtml(u.email)}</span></td>
      <td><span class="role-badge ${u.account_type}">${u.account_type==='administrator'?'Administrator':'Member'}</span></td>
      <td>
        ${u.account_type==='administrator' ? '<span class="role-badge none">—</span>' : `
        <select class="mini-select" onchange="setClubRole('${u.id}', this.value)">
          <option value="" ${!u.club_role?'selected':''}>— none —</option>
          <option value="Editor" ${u.club_role==='Editor'?'selected':''}>Editor</option>
          <option value="Photographer" ${u.club_role==='Photographer'?'selected':''}>Photographer</option>
        </select>`}
      </td>
      <td><select class="mini-select" onchange="setOfficer('${u.id}', this.value)">${officerOptionsHtml(u.officer)}</select></td>
      <td>
        ${u.suspended ? '<span class="status-dot offline"></span>suspended' : `<span class="status-dot ${online?'online':'offline'}"></span>${online?'online':'offline'}`}
      </td>
      <td class="mono" style="font-size:11px;">${formatJoined(u.created_at)}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        ${u.account_type==='member'
          ? `<button class="mini-btn" onclick="promoteUser('${u.id}')" ${adminCount()>=ADMIN_SEAT_LIMIT?'disabled title="Admin seat limit reached"':''}>Promote</button>`
          : `<button class="mini-btn" onclick="demoteUser('${u.id}')">Demote</button>`}
        ${u.suspended
          ? `<button class="mini-btn" onclick="reactivateUser('${u.id}')">Reactivate</button>`
          : `<button class="mini-btn" onclick="suspendUser('${u.id}')">Suspend</button>`}
        <button class="mini-btn" onclick="resetUserPassword('${u.id}','${u.email}')">Reset PW</button>
        <button class="mini-btn danger" onclick="deleteUser('${u.id}')">Delete</button>
      </td>
    </tr>`;
  }).join('') : `<tr><td colspan="7"><div class="empty-state">No members match that search.</div></td></tr>`;
}
document.getElementById('userSearch').addEventListener('input', debounce(e=>{ state.userFilter.search=e.target.value; renderAdminUsers(); }, 180));
document.getElementById('userFilterType').addEventListener('change', e=>{ state.userFilter.type=e.target.value; renderAdminUsers(); });
document.getElementById('userFilterStatus').addEventListener('change', e=>{ state.userFilter.status=e.target.value; renderAdminUsers(); });

async function writeAudit(action, targetId, detail){
  try{
    await sb.from('audit_log').insert({ actor_id: state.currentUser?.id, action, target_id: targetId, detail });
  }catch(e){ /* non-critical */ }
  fetchAuditLog();
}

async function promoteUser(id){
  if(!requireBackend()) return;
  if(adminCount()>=ADMIN_SEAT_LIMIT){ writeAudit('promote_blocked', id, 'Admin seat limit reached'); return; }
  const { error } = await sb.from('profiles').update({account_type:'administrator', club_role:null}).eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('promote', id, 'Promoted to Administrator');
}
async function demoteUser(id){
  if(!requireBackend()) return;
  const { error } = await sb.from('profiles').update({account_type:'member'}).eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('demote', id, 'Demoted to Member');
}
async function setClubRole(id, role){
  if(!requireBackend()) return;
  const { error } = await sb.from('profiles').update({club_role: role || null}).eq('id', id);
  if(!error) writeAudit('set_club_role', id, role || 'none');
}
async function setOfficer(id, position){
  if(!requireBackend()) return;
  const { error } = await sb.from('profiles').update({officer: position || null}).eq('id', id);
  if(!error) writeAudit('set_officer', id, position || 'none');
}
async function suspendUser(id){
  if(!requireBackend()) return;
  const { error } = await sb.from('profiles').update({suspended:true}).eq('id', id);
  if(!error) writeAudit('suspend', id, 'Account suspended');
}
async function reactivateUser(id){
  if(!requireBackend()) return;
  const { error } = await sb.from('profiles').update({suspended:false}).eq('id', id);
  if(!error) writeAudit('reactivate', id, 'Account reactivated');
}
async function resetUserPassword(id, email){
  if(!requireBackend()) return;
  const { error } = await sb.auth.resetPasswordForEmail(email);
  writeAudit('reset_password', id, error ? 'Failed: '+error.message : 'Reset email sent');
  if(error) alert(error.message);
}
async function deleteUser(id){
  if(!requireBackend()) return;
  if(!confirm('Permanently delete this member? This removes their login and all profile data and cannot be undone.')) return;

  // Try the edge function first — it deletes the actual Supabase Auth
  // login (profile data cascades automatically). If it isn't deployed
  // yet, fall back to removing just the profile row so the admin panel
  // still works without it (see supabase/functions/delete-user).
  const { data, error } = await sb.functions.invoke('delete-user', { body: { user_id: id } });
  if(!error && data?.success){
    writeAudit('delete_user', id, 'Account fully deleted (auth + profile)');
    return;
  }

  const { error: profileError } = await sb.from('profiles').delete().eq('id', id);
  if(profileError){ alert(profileError.message); return; }
  writeAudit('delete_profile', id, 'Profile data deleted — auth login remains until the delete-user edge function is deployed (see README)');
}

/* ============================================================
   ADMIN — live stats, login monitoring, audit log
   ============================================================ */
async function renderAdminStats(){
  if(document.getElementById('admin').classList.contains('hidden')) return;
  const online = presenceOnlineIds();
  const onlineMembers = cache.profiles.filter(u=>!u.suspended && online.has(u.id)).length;
  const admins = adminCount();
  document.getElementById('adminSeatsChip').textContent = `${admins}/${ADMIN_SEAT_LIMIT} admin seats used`;

  const now = new Date();
  const startToday = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const startWeek = new Date(now - 7*86400000);
  const startMonth = new Date(now - 30*86400000);
  const newToday = cache.profiles.filter(p=> new Date(p.created_at) >= startToday).length;
  const newWeek = cache.profiles.filter(p=> new Date(p.created_at) >= startWeek).length;
  const newMonth = cache.profiles.filter(p=> new Date(p.created_at) >= startMonth).length;

  document.getElementById('adminStats').innerHTML = [
    {n: cache.profiles.length, l:'Total registered members'},
    {n: admins, l:'Administrators'},
    {n: onlineMembers, l:'Members currently online'},
    {n: presenceCount(), l:'Live active users', live:true},
  ].map(s=>`<div class="stat glass"><div class="n ${s.live?'live':''}">${s.live?'<span class="pulse-dot"></span>':''}${s.n}</div><div class="l">${s.l}</div></div>`).join('');

  const { visitsToday, visitsTotal } = await fetchPageViewStats();
  const stats2 = document.getElementById('adminStats2');
  stats2.style.gridTemplateColumns = 'repeat(5,1fr)';
  stats2.innerHTML = [
    {n: newToday, l:'New registrations today'},
    {n: newWeek, l:'Registrations this week'},
    {n: newMonth, l:'Registrations this month'},
    {n: visitsToday, l:'Website visits today'},
    {n: visitsTotal, l:'Total website visits'},
  ].map(s=>`<div class="stat glass"><div class="n">${s.n}</div><div class="l">${s.l}</div></div>`).join('');

  fetchLoginMonitor();
  fetchAuditLog();
}
async function fetchPageViewStats(){
  const startToday = new Date(); startToday.setHours(0,0,0,0);
  const [{count:visitsToday}, {count:visitsTotal}] = await Promise.all([
    sb.from('page_views').select('*', {count:'exact', head:true}).gte('viewed_at', startToday.toISOString()),
    sb.from('page_views').select('*', {count:'exact', head:true}),
  ]);
  return { visitsToday: visitsToday ?? 0, visitsTotal: visitsTotal ?? 0 };
}

function renderLoginMonitor(){
  const wrap = document.getElementById('loginMonitor');
  wrap.innerHTML = cache.loginEvents.length ? cache.loginEvents.map(ev=>`
    <div class="activity-item">
      <div class="avatar"></div>
      <div class="txt">✔ <b>${escapeHtml(ev.profiles?.name || 'Unknown')}</b> signed in <span style="color:var(--text-2);">· ${escapeHtml(ev.device||'')}</span></div>
      <div class="time">${new Date(ev.created_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</div>
    </div>
  `).join('') : `<div class="empty-state">No login activity yet.</div>`;
}
function renderAdminActivity(rows){
  document.getElementById('adminActivity').innerHTML = (rows||[]).length ? rows.map(a=>`
    <div class="activity-item"><div class="avatar"></div><div class="txt">${escapeHtml(a.action)}${a.detail?' — '+escapeHtml(a.detail):''}</div><div class="time">${new Date(a.created_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</div></div>
  `).join('') : `<div class="empty-state">No admin activity logged yet.</div>`;
}

/* ============================================================
   STATIC UI (theme, notifications, scroll reveal)
   ============================================================ */
function wireStaticControls(){
  document.getElementById('themeSwitch').addEventListener('click', ()=>{
    state.theme = state.theme==='dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', state.theme);
    document.getElementById('themeSwitch').querySelector('.knob').textContent = state.theme==='dark' ? '☀' : '🌙';
  });
  document.addEventListener('click', e=>{
    const btn = e.target.closest('.btn');
    if(!btn) return;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className='ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size+'px';
    ripple.style.left = (e.clientX-rect.left-size/2)+'px';
    ripple.style.top = (e.clientY-rect.top-size/2)+'px';
    btn.appendChild(ripple);
    setTimeout(()=>ripple.remove(), 650);
  });
  document.getElementById('notifBtn').addEventListener('click', e=>{ e.stopPropagation(); document.getElementById('notifPanel').classList.toggle('open'); });
  document.addEventListener('click', ()=> document.getElementById('notifPanel').classList.remove('open'));
  renderNotifications();
  renderSocialLinks();
}

/* Simple, original line-icon glyphs — not traced from any brand's
   official assets, just enough shape to be recognizable. */
const SOCIAL_ICONS = {
  instagram: `<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor"/>`,
  facebook: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 8.5h-1.5c-.8 0-1.2.4-1.2 1.2V11h2.5l-.3 2.2h-2.2V19h-2.3v-5.8H9V11h1.5V9.3c0-1.8 1.1-3 3-3H14z" fill="currentColor"/>`,
  twitter: `<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 7.5l9 9M16.5 7.5l-9 9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
  youtube: `<rect x="3" y="6" width="18" height="12" rx="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.2 9.6l4.6 2.4-4.6 2.4z" fill="currentColor"/>`,
  tiktok: `<path d="M13 3v10.8a3 3 0 1 1-2-2.83V3h2z" fill="currentColor"/><path d="M13 3.3c.35 2.2 2 3.85 4.2 4.05v1.8c-1.55 0-2.95-.5-4.2-1.35" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
};
const SOCIAL_LABELS = { instagram:'Instagram', facebook:'Facebook', twitter:'X (Twitter)', youtube:'YouTube', tiktok:'TikTok' };
function renderSocialLinks(){
  const row = document.getElementById('socialRow');
  if(!row || typeof SOCIAL_LINKS === 'undefined') return;
  const links = Object.keys(SOCIAL_ICONS)
    .filter(key => SOCIAL_LINKS[key] && SOCIAL_LINKS[key].trim())
    .map(key => `<a href="${escapeHtml(SOCIAL_LINKS[key].trim())}" target="_blank" rel="noopener noreferrer" aria-label="${SOCIAL_LABELS[key]}" title="${SOCIAL_LABELS[key]}"><svg viewBox="0 0 24 24" fill="none">${SOCIAL_ICONS[key]}</svg></a>`);
  row.innerHTML = links.join('');
}
function renderNotifications(){
  const panel = document.getElementById('notifPanel');
  document.getElementById('notifBadge').style.display = notifications.length ? 'flex' : 'none';
  document.getElementById('notifBadge').textContent = notifications.length;
  panel.innerHTML = notifications.length ? notifications.map(n=>`
    <div class="notif-item"><div class="dot"></div><div><div class="body">${n.text}</div><div class="time">${n.time}</div></div></div>
  `).join('') : `<div class="empty-state">You're all caught up.</div>`;
}
function setupScrollReveal(){
  document.querySelectorAll('.reveal').forEach(el=>{
    const obs = new IntersectionObserver(entries=>{ entries.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('in'); obs.unobserve(e.target); } }); }, {threshold:.15});
    obs.observe(el);
  });
}
function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str==null ? '' : String(str);
  return div.innerHTML;
}

/* ============================================================
   SOLIS — conversational assistant (same NLU engine as before,
   now reading/writing real Supabase data)
   ============================================================ */
const solisCtx = { lastTopic:null, pendingConfirm:null, history:[], currentSection:'home', sectionVisits:{}, proactiveSent:{}, chatOpenedOnce:false };
const defaultSolisSuggestions = ["What's the next event?","Where are announcements?","What can you help with?"];
let solisUnread = 0;

function normalize(text){ return text.toLowerCase().replace(/[^\w\s']/g,' ').replace(/\s+/g,' ').trim(); }
function levenshtein(a,b){
  const m=a.length,n=b.length; if(!m) return n; if(!n) return m;
  const d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);
  for(let j=0;j<=n;j++) d[0][j]=j;
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++) d[i][j] = a[i-1]===b[j-1] ? d[i-1][j-1] : 1+Math.min(d[i-1][j],d[i][j-1],d[i-1][j-1]);
  return d[m][n];
}
function fuzzyIncludes(norm, keyword){
  if(norm.includes(keyword)) return true;
  if(keyword.includes(' ')) return false;
  return norm.split(' ').some(tok=> tok.length>3 && keyword.length>3 && levenshtein(tok,keyword) <= (keyword.length>6?2:1));
}
function tryFollowUp(norm, ctx){
  const t = ctx.lastTopic; if(!t) return null;
  if(!/\b(it|that|this|its)\b/.test(norm)) return null;
  if(t.type==='event'){
    const ev = cache.events.find(e=>e.id===t.id); if(!ev) return null;
    if(/(end|finish|over|wrap)/.test(norm)){
      const end = new Date(new Date(ev.event_date).getTime()+2*3600000);
      return { text:`${ev.title} wraps up around ${end.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})} — about two hours after it starts.` };
    }
    if(/(where|location|place|venue)/.test(norm)) return { text:`It's happening at <b>${ev.location}</b>.` };
    if(/(when|start|time|date)/.test(norm)) return { text:`${ev.title} starts ${formatFull(ev.event_date)}.` };
  }
  if(t.type==='announcement'){
    const a = cache.announcements.find(x=>x.id===t.id); if(!a) return null;
    if(/(who|author|posted|wrote)/.test(norm)) return {text:`That one was posted by <b>${a.author}</b>.`};
    if(/(when|date|posted)/.test(norm)) return {text:`It went up on ${formatDate(a.created_at)}.`};
  }
  return null;
}
const solisIntents = [
  { id:'greeting', kw:['hello','hi','hey','yo','sup','greetings'],
    respond:()=>({ text:"Hi there! 👋 I can help you find announcements, events, or news — what are you looking for?",
      quickActions:[{label:'📣 Announcements',style:'safe',action:'go_announcements'},{label:'📅 Events',style:'safe',action:'go_events'},{label:'📰 News',style:'safe',action:'go_news'}] }) },
  { id:'announcements', kw:['announcement','announcements','pinned','post','notice'],
    respond:(ctx)=>{
      const pinned = cache.announcements.filter(a=>a.pinned);
      const top = pinned[0] || cache.announcements[0];
      if(!top) return { text:"There are no announcements yet." };
      ctx.lastTopic = {type:'announcement', id:top.id};
      return { text: pinned.length ? `There ${pinned.length>1?'are':'is'} ${pinned.length} pinned announcement${pinned.length>1?'s':''}, including <b>${top.title}</b>.` : `Nothing's pinned right now, but here's the latest: <b>${top.title}</b>.`,
        quickActions:[{label:'Open announcements', style:'safe', action:'go_announcements'}] };
    } },
  { id:'events', kw:['event','events','calendar','schedule','happening','meeting'],
    respond:(ctx)=>{
      const ev = nextEvent(); if(!ev) return { text:"There aren't any upcoming events scheduled right now." };
      ctx.lastTopic = {type:'event', id:ev.id};
      return { text:`The next scheduled event is <b>${ev.title}</b> on ${formatFull(ev.event_date)}, at ${ev.location}.`,
        quickActions:[{label:'What time does it end?',style:''},{label:'Open events', style:'safe', action:'go_events'}] };
    } },
  { id:'news', kw:['news','story','stories','article'],
    respond:(ctx)=>{ const n = cache.news[0]; if(!n) return {text:"No news posted yet."}; ctx.lastTopic={type:'news',id:n.id};
      return { text:`Here's a recent story: <b>${n.title}</b> — ${n.body}`, quickActions:[{label:'Open news', style:'safe', action:'go_news'}] }; } },
  { id:'collaborations', kw:['collaboration','collaborations','partner club','partnership','photos','videos','pictures','media','gallery','upload'],
    respond:()=>{
      const c = cache.collaborations[0];
      const base = c
        ? `The most recent collaboration is <b>${c.title}</b> with ${c.partner_club}. `
        : `There aren't any collaborations posted yet. `;
      return { text: base + `Any logged-in member can also share photos or videos there for events, announcements, or collaborations.`,
        quickActions:[{label:'Open collaborations', style:'safe', action:'go_collaborations'}] };
    } },
  { id:'event_request', kw:['post our event','post an event','list our event','other club','request an event','submit an event','feature our event'],
    respond:()=>({ text:"If you're from another club, there's a form for exactly that — no account needed. Fill in your club name, contact info, and event details, and an officer will review it.",
      quickActions:[{label:'Open the form', style:'safe', action:'go_event_requests'}] }) },
  { id:'login', kw:['login','log in','signin','sign in'],
    respond:()=>({ text:"There's no visible login button by design — the member portal opens with a hidden keyboard sequence. If you don't know it, ask a current officer." }) },
  { id:'register', kw:['register','sign up','signup','join'],
    respond:()=>({ text:"New accounts join as a Member through the same hidden portal as login — club roles and officer titles are assigned afterward by an administrator." }) },
  { id:'dashboard', kw:['dashboard','my profile','saved'],
    respond:()=>{
      if(!state.currentUser) return { text:"You'll need to be logged in first — your dashboard shows your club role, officer position, and saved announcements." };
      return { text:`Your dashboard has <b>${cache.savedIds.size}</b> saved announcement${cache.savedIds.size!==1?'s':''}.`, quickActions:[{label:'Open dashboard', style:'safe', action:'go_dashboard'}] };
    } },
  { id:'admin_overview', kw:['admin dashboard','admin panel','analytics','statistics'],
    respond:()=>{
      if(!isAdmin()) return { text:"The admin dashboard is only visible to logged-in administrators." };
      return { text:`There are <b>${cache.profiles.length}</b> members and <b>${adminCount()}/${ADMIN_SEAT_LIMIT}</b> admin seats used.`, quickActions:[{label:'Open admin panel', style:'safe', action:'go_admin'}] };
    } },
  { id:'admin_user_mgmt', kw:['promote','demote','suspend','delete member','remove member','ban'],
    respond:(ctx, norm)=>{
      if(!isAdmin()) return { text:"Member management is only available to administrators." };
      let action=null;
      if(/\bsuspend|ban\b/.test(norm)) action='suspend'; else if(/\bdelete|remove\b/.test(norm)) action='delete';
      else if(/\bdemote\b/.test(norm)) action='demote'; else if(/\bpromote\b/.test(norm)) action='promote';
      if(!action) return { text:'Try something like "suspend Devon Brooks", or open the admin panel directly.', quickActions:[{label:'Open admin panel', style:'safe', action:'go_admin'}] };
      if(action==='promote' && adminCount()>=ADMIN_SEAT_LIMIT) return { text:`Both administrator seats are filled — demote someone first.` };
      let namePart = norm.replace(/\b(suspend|ban|delete|remove|promote|demote|member|the|please|account|to|administrator|admin)\b/g,'').trim();
      if(!namePart) return { text:`Who would you like to ${action}?` };
      const match = cache.profiles.find(u=> u.name.toLowerCase().includes(namePart));
      if(!match) return { text:`I couldn't find a member matching "${namePart}".` };
      ctx.pendingConfirm = {type:action, userId:match.id};
      return { text:`Confirm: ${action} <b>${match.name}</b>?`, quickActions:[{label:'Yes, '+action, style:'confirm', action:action+'_'+match.id},{label:'Cancel', style:'safe', action:'cancel_admin_action'}] };
    } },
  { id:'capabilities', kw:['help','what can you do','commands'],
    respond:()=>({ text:'I can help you find announcements, events, and news, and — if you\'re an admin — manage members. Just ask naturally.',
      quickActions:[{label:'Show announcements', style:'safe', action:'go_announcements'},{label:'Show events', style:'safe', action:'go_events'}] }) },
  { id:'thanks', kw:['thank','thanks'], respond:()=>({ text:"Anytime!" }) },
];
function scoreIntents(norm){
  return solisIntents.map(intent=>{
    let score=0;
    intent.kw.forEach(k=>{ if(norm.includes(k)) score+=2; else if(fuzzyIncludes(norm,k)) score+=1; });
    return {intent, score};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score);
}
async function runPendingConfirm(ctx){
  const pc = ctx.pendingConfirm; ctx.pendingConfirm=null;
  if(!pc) return { text:"Nothing pending to confirm." };
  return executeAdminAction(pc.type, pc.userId);
}
async function executeAdminAction(type, userId){
  const u = cache.profiles.find(x=>x.id===userId);
  const name = u ? u.name : 'the member';
  if(type==='suspend'){ await suspendUser(userId); return { text:`Done — <b>${name}</b> suspended.` }; }
  if(type==='delete'){ await deleteUser(userId); return { text:`Done — <b>${name}</b> removed.` }; }
  if(type==='promote'){ await promoteUser(userId); return { text:`Done — <b>${name}</b> promoted.` }; }
  if(type==='demote'){ await demoteUser(userId); return { text:`Done — <b>${name}</b> demoted.` }; }
  return { text:"Okay." };
}
async function getSolisReply(rawText, ctx){
  const norm = normalize(rawText);
  if(ctx.pendingConfirm){
    if(/^(yes|yep|yeah|confirm|do it|sure)/.test(norm)) return await runPendingConfirm(ctx);
    if(/^(no|cancel|nevermind|stop)/.test(norm)){ ctx.pendingConfirm=null; return { text:"Okay, no changes made." }; }
  }
  const followUp = tryFollowUp(norm, ctx); if(followUp) return followUp;
  const ranked = scoreIntents(norm);
  if(!ranked.length) return { text:`I don't have an exact answer for that. Try announcements, events, or news.`, suggestions:defaultSolisSuggestions };
  return ranked[0].intent.respond(ctx, norm);
}
function addMsg(text, sender, opts={}){
  const body = document.getElementById('solisBody');
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + (sender==='user' ? 'user-wrap' : 'bot-wrap');
  const bubble = document.createElement('div');
  bubble.className = 'msg ' + (sender==='user' ? 'user' : 'bot');
  if(sender==='bot') bubble.innerHTML = text; else bubble.textContent = text;
  wrap.appendChild(bubble);
  if(opts.quickActions?.length){
    const qa = document.createElement('div'); qa.className='msg-quickactions';
    opts.quickActions.forEach(a=>{
      const btn=document.createElement('button'); btn.type='button'; btn.textContent=a.label; btn.className=a.style||'';
      btn.onclick = ()=> handleQuickAction(a.action, qa);
      qa.appendChild(btn);
    });
    wrap.appendChild(qa);
  }
  body.appendChild(wrap); body.scrollTop = body.scrollHeight;
  if(sender==='bot' && !solisIsVisible()) bumpSolisBadge();
}
function addBotMsg(text, opts){ addMsg(text,'bot',opts||{}); }
function addUserMsg(text){ addMsg(text,'user'); }
function addSolisMsg(text, opts){ if(document.getElementById('solisWindow')) addBotMsg(text, opts); }
function renderSolisSuggestions(list){
  document.getElementById('solisSuggest').innerHTML = list.map(s=>`<button class="chip" onclick='askSuggestion(${JSON.stringify(s)})'>${s}</button>`).join('');
}
function renderWelcome(){
  addMsg("Hi, I'm Solis ✨ — I can help you find announcements, events, and news. What are you looking for?", 'bot', {
    quickActions:[{label:'📣 Announcements', style:'safe', action:'go_announcements'},{label:'📅 Events', style:'safe', action:'go_events'},{label:'📰 News', style:'safe', action:'go_news'}] });
  renderSolisSuggestions(defaultSolisSuggestions);
}
function setupSolis(){ renderWelcome(); setupSectionTracking(); }

/* ---------- proactive greeting bubble near the Solis button ---------- */
const SOLIS_GREETINGS = [
  "Hi, I'm Solis 👋 This is the Multimedia Club hub — announcements, events, news, and club collaborations all live here. Ask me anything, or just look around.",
  "Welcome! I'm Solis, the club's guide. Check Events for what's coming up, Announcements for the latest updates, or ask me directly — I'm always here.",
  "Hey there ✨ I'm Solis. New here? This site covers club announcements, upcoming events, news, and collaborations with other clubs — happy to point you anywhere.",
];
const SOLIS_GREETING_STORAGE_KEY = 'solisGreetingLastShown';
let solisGreetingShown = false;

function pickSolisGreetingText(){
  // Prefer something real and current over the generic explainer —
  // a pinned announcement or the next event is more useful the
  // moment someone lands on the site than a canned intro line.
  const pinned = cache.announcements?.find(a => a.pinned);
  if(pinned) return `Hi, I'm Solis 👋 There's a pinned announcement right now: <b>${escapeHtml(pinned.title)}</b>. Want the details, or a look around the site?`;
  const ev = typeof nextEvent === 'function' ? nextEvent() : null;
  if(ev) return `Hi, I'm Solis 👋 The next event is <b>${escapeHtml(ev.title)}</b> on ${formatDate(ev.event_date)}. I can also point you to announcements, news, or collaborations.`;
  return SOLIS_GREETINGS[Math.floor(Math.random()*SOLIS_GREETINGS.length)];
}

function shouldShowSolisGreetingToday(){
  try{
    const last = localStorage.getItem(SOLIS_GREETING_STORAGE_KEY);
    const today = new Date().toDateString();
    if(last === today) return false;
    localStorage.setItem(SOLIS_GREETING_STORAGE_KEY, today);
    return true;
  }catch(e){
    // Storage blocked (private browsing, etc.) — fall back to
    // showing it, same as before this change.
    return true;
  }
}

function showSolisGreeting(){
  if(solisGreetingShown || solisCtx.chatOpenedOnce) return;
  if(!shouldShowSolisGreetingToday()) return;
  solisGreetingShown = true;
  const bubble = document.getElementById('solisGreetBubble');
  const textEl = document.getElementById('solisGreetText');
  if(!bubble || !textEl) return;
  textEl.innerHTML = pickSolisGreetingText();
  bubble.classList.add('show');
  setTimeout(hideSolisGreeting, 11000);
}
// Show right as the intro loader actually finishes clearing the
// screen, not on a guessed delay — previously this fired at a fixed
// 1.8s while the full-screen loader was still covering everything
// for ~4.9s, silently burning through a third of its visible window
// behind it. A short fallback timer covers browsers/edge cases where
// the loader event never fires for any reason.
window.addEventListener('introLoaderDone', showSolisGreeting, { once:true });
setTimeout(showSolisGreeting, 6000);
function hideSolisGreeting(){
  document.getElementById('solisGreetBubble')?.classList.remove('show');
}
function openSolisFromGreeting(){
  hideSolisGreeting();
  openSolis();
}
function dismissSolisGreeting(event){
  event.stopPropagation();
  hideSolisGreeting();
}

async function handleQuickAction(action, qaWrap){
  if(qaWrap) Array.from(qaWrap.children).forEach(b=>b.disabled=true);
  if(action==='go_announcements'){ scrollToId('announcements'); return; }
  if(action==='go_events'){ scrollToId('events'); return; }
  if(action==='go_news'){ scrollToId('news'); return; }
  if(action==='go_collaborations'){ scrollToId('collaborations'); return; }
  if(action==='go_event_requests'){ scrollToId('event-requests'); return; }
  if(action==='go_dashboard'){ scrollToId('dashboard'); return; }
  if(action==='go_admin'){ scrollToId('admin'); return; }
  if(action==='cancel_admin_action'){ solisCtx.pendingConfirm=null; addBotMsg('Okay, no changes made.'); return; }
  const m = action.match(/^(suspend|delete|promote|demote)_(.+)$/);
  if(m){ const reply = await executeAdminAction(m[1], m[2]); addBotMsg(reply.text); solisCtx.pendingConfirm=null; return; }
}
function askSuggestion(text){ document.getElementById('solisInput').value=text; sendSolis(); }
function openSolis(){ document.getElementById('solisWindow').classList.remove('minimized'); document.getElementById('solisWindow').classList.add('open'); document.getElementById('solisMinibar').classList.add('hidden'); document.getElementById('solisInput').focus(); solisCtx.chatOpenedOnce=true; clearSolisBadge(); hideSolisGreeting(); }
function closeSolis(){ document.getElementById('solisWindow').classList.remove('open'); document.getElementById('solisMinibar').classList.add('hidden'); }
function minimizeSolis(){ document.getElementById('solisWindow').classList.remove('open'); document.getElementById('solisMinibar').classList.remove('hidden'); }
function restoreSolis(){ openSolis(); }
function clearSolisChat(){ document.getElementById('solisBody').innerHTML=''; solisCtx.history=[]; solisCtx.lastTopic=null; solisCtx.pendingConfirm=null; renderWelcome(); }
function solisIsVisible(){ return document.getElementById('solisWindow').classList.contains('open'); }
function clearSolisBadge(){ solisUnread=0; document.getElementById('solisBtnBadge').classList.add('hidden'); document.getElementById('solisMiniBadge').style.display='none'; }
function bumpSolisBadge(){ solisUnread++; const b1=document.getElementById('solisBtnBadge'); b1.textContent=solisUnread; b1.classList.remove('hidden'); const b2=document.getElementById('solisMiniBadge'); b2.style.display='flex'; b2.textContent=solisUnread; }
function updateSolisStatusLine(){
  const labelMap = {home:'Home', announcements:'Announcements', events:'Events', news:'News', collaborations:'Collaborations', 'event-requests':'For Clubs', dashboard:'Dashboard', admin:'Admin'};
  const roleTxt = state.currentUser ? ' · '+(state.currentUser.account_type==='administrator'?'Administrator':(state.currentUser.club_role||'Member')) : '';
  const el = document.getElementById('solisStatusLine');
  if(el) el.textContent = `● online${roleTxt} · sees ${labelMap[solisCtx.currentSection]||'Home'}`;
}
function trackSection(id){
  solisCtx.currentSection = id;
  solisCtx.sectionVisits[id] = (solisCtx.sectionVisits[id]||0)+1;
  updateSolisStatusLine();
}
function setupSectionTracking(){
  ['home','announcements','events','news','collaborations','event-requests','dashboard','admin'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const obs = new IntersectionObserver(entries=>{ entries.forEach(e=>{ if(e.isIntersecting) trackSection(id); }); }, {threshold:0.35});
    obs.observe(el);
  });
}
async function sendSolis(){
  const input = document.getElementById('solisInput');
  const text = input.value.trim(); if(!text) return;
  addUserMsg(text); input.value='';
  showTyping();
  const delay = 450 + Math.min(500, text.length*8);
  setTimeout(async ()=>{
    hideTyping();
    const reply = await getSolisReply(text, solisCtx);
    addBotMsg(reply.text, { quickActions:reply.quickActions });
    renderSolisSuggestions(reply.suggestions || defaultSolisSuggestions);
  }, delay);
}
function showTyping(){
  const body=document.getElementById('solisBody');
  const div=document.createElement('div'); div.className='msg bot typing-wrap'; div.id='typingIndicator';
  div.innerHTML='<div class="typing"><span></span><span></span><span></span></div>'; div.style.padding='0';
  body.appendChild(div); body.scrollTop=body.scrollHeight;
}
function hideTyping(){ document.getElementById('typingIndicator')?.remove(); }
