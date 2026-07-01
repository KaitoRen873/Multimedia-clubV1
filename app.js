/* ============================================================
   Multimedia Club — application logic (v1, Supabase-backed)
   ------------------------------------------------------------
   This replaces the old in-memory mock DB with real Supabase
   tables, real Supabase Auth, and Realtime subscriptions. See
   supabase/schema.sql for the full backend definition and
   README.md for setup steps.
   ============================================================ */

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const OFFICER_POSITIONS = [
  "President","Vice President","Secretary","Assistant Secretary","Treasurer","Assistant Treasurer",
  "Auditor","Public Information Officer (PIO)","Assistant PIO","Business Manager","Assistant Business Manager",
  "Grade Level Representative","Committee Head"
];
const ADMIN_SEAT_LIMIT = 2;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 20000;

/* ---------- local cache (kept in sync with Supabase via realtime) ---------- */
const cache = {
  profiles: [],
  announcements: [],
  events: [],
  news: [],
  savedIds: new Set(),
  loginEvents: [],
};

let state = {
  currentUser: null,           // profile row of the signed-in user, or null
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

  await Promise.all([fetchAnnouncements(), fetchEvents(), fetchNews(), fetchProfiles()]);
  renderAdminStats();
  logPageView();
  setupRealtimeSubscriptions();
  setupPresence();

  setInterval(tickCountdowns, 1000);
  setInterval(()=>{ if(!document.getElementById('admin').classList.contains('hidden')){ renderAdminStats(); } }, 5000);
});

async function logPageView(){
  try{ await sb.from('page_views').insert({}); }catch(e){ /* non-critical */ }
}

/* ============================================================
   AUTH — real Supabase Auth
   ============================================================ */
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
}
function showAuthMsg(text, type){ const el=document.getElementById('authMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleLogin(e){
  e.preventDefault();
  const btn = document.getElementById('loginSubmitBtn');
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

async function handleRegister(e){
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;

  const { data, error } = await sb.auth.signUp({
    email, password,
    options: { data: { name } }
  });
  if(error){ showAuthMsg(error.message, 'err'); return; }

  if(!data.session){
    showAuthMsg('Account created! Check your email to confirm before logging in.', 'ok');
    switchAuthTab('login');
    return;
  }
  await recordLoginEvent(data.user.id);
  showAuthMsg('Welcome to the club!', 'ok');
  setTimeout(closeAuth, 700);
}

function forgotPassword(){
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
  document.getElementById('userMenuWrap').classList.remove('hidden');
  document.getElementById('userMenuWrap').style.display='flex';
  document.getElementById('userGreeting').textContent = user.name + ' · ' + accountLabel(user);
  document.getElementById('navDashboardLink').classList.remove('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('dashWelcome').textContent = 'Welcome back, '+user.name.split(' ')[0];
  if(user.account_type==='administrator'){
    document.getElementById('navAdminLink').classList.remove('hidden');
    document.getElementById('admin').classList.remove('hidden');
  } else {
    document.getElementById('navAdminLink').classList.add('hidden');
    document.getElementById('admin').classList.add('hidden');
  }
  fetchSaved();
  renderDashboardProfile();
  renderDashboardNextEvent();
  renderAnnouncements();
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
  document.getElementById('userMenuWrap').classList.add('hidden');
  document.getElementById('navDashboardLink').classList.add('hidden');
  document.getElementById('navAdminLink').classList.add('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('admin').classList.add('hidden');
  updateSolisStatusLine();
  renderAnnouncements();
  if(presenceChannel) trackPresence();
}
document.getElementById('logoutBtn').addEventListener('click', async ()=>{ await sb.auth.signOut(); scrollToId('home'); });

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
  sb.channel('public:announcements').on('postgres_changes', {event:'*', schema:'public', table:'announcements'}, fetchAnnouncements).subscribe();
  sb.channel('public:events').on('postgres_changes', {event:'*', schema:'public', table:'events'}, fetchEvents).subscribe();
  sb.channel('public:news').on('postgres_changes', {event:'*', schema:'public', table:'news'}, fetchNews).subscribe();
  sb.channel('public:profiles').on('postgres_changes', {event:'*', schema:'public', table:'profiles'}, async (payload)=>{
    await fetchProfiles();
    if(state.currentUser && payload.new && payload.new.id===state.currentUser.id){
      if(payload.new.suspended){ await sb.auth.signOut(); return; }
      state.currentUser = payload.new;
      document.getElementById('userGreeting').textContent = payload.new.name + ' · ' + accountLabel(payload.new);
      renderDashboardProfile();
    }
  }).subscribe();
}

function setupPresence(){
  presenceChannel = sb.channel('site-presence', { config: { presence: { key: presenceKey } } });
  presenceChannel
    .on('presence', {event:'sync'}, renderAdminStats)
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
document.getElementById('annSearch').addEventListener('input', e=>{ state.annFilter.search=e.target.value; renderAnnouncements(); });
document.getElementById('annCategory').addEventListener('change', e=>{ state.annFilter.category=e.target.value; renderAnnouncements(); });

async function toggleSave(id){
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
  const { error } = await sb.from('announcements').update({pinned: !currentlyPinned}).eq('id', id);
  if(!error) writeAudit('pin_toggle', null, `Announcement #${id} pinned=${!currentlyPinned}`);
}
async function deleteAnnouncement(id){
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
document.getElementById('newsSearch').addEventListener('input', e=> renderNews(e.target.value));

/* ============================================================
   ADMIN — publish content
   ============================================================ */
function switchPublishTab(tab){
  publishTab = tab;
  document.getElementById('publishTabAnn').classList.toggle('active', tab==='announcement');
  document.getElementById('publishTabEvent').classList.toggle('active', tab==='event');
  document.getElementById('announcementForm').classList.toggle('hidden', tab!=='announcement');
  document.getElementById('eventForm').classList.toggle('hidden', tab!=='event');
}
function showPublishMsg(text, type){ const el=document.getElementById('publishMsg'); el.textContent=text; el.className='form-msg show '+type; }

async function handleCreateAnnouncement(e){
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
document.getElementById('userSearch').addEventListener('input', e=>{ state.userFilter.search=e.target.value; renderAdminUsers(); });
document.getElementById('userFilterType').addEventListener('change', e=>{ state.userFilter.type=e.target.value; renderAdminUsers(); });
document.getElementById('userFilterStatus').addEventListener('change', e=>{ state.userFilter.status=e.target.value; renderAdminUsers(); });

async function writeAudit(action, targetId, detail){
  try{
    await sb.from('audit_log').insert({ actor_id: state.currentUser?.id, action, target_id: targetId, detail });
  }catch(e){ /* non-critical */ }
  fetchAuditLog();
}

async function promoteUser(id){
  if(adminCount()>=ADMIN_SEAT_LIMIT){ writeAudit('promote_blocked', id, 'Admin seat limit reached'); return; }
  const { error } = await sb.from('profiles').update({account_type:'administrator', club_role:null}).eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('promote', id, 'Promoted to Administrator');
}
async function demoteUser(id){
  const { error } = await sb.from('profiles').update({account_type:'member'}).eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('demote', id, 'Demoted to Member');
}
async function setClubRole(id, role){
  const { error } = await sb.from('profiles').update({club_role: role || null}).eq('id', id);
  if(!error) writeAudit('set_club_role', id, role || 'none');
}
async function setOfficer(id, position){
  const { error } = await sb.from('profiles').update({officer: position || null}).eq('id', id);
  if(!error) writeAudit('set_officer', id, position || 'none');
}
async function suspendUser(id){
  const { error } = await sb.from('profiles').update({suspended:true}).eq('id', id);
  if(!error) writeAudit('suspend', id, 'Account suspended');
}
async function reactivateUser(id){
  const { error } = await sb.from('profiles').update({suspended:false}).eq('id', id);
  if(!error) writeAudit('reactivate', id, 'Account reactivated');
}
async function resetUserPassword(id, email){
  const { error } = await sb.auth.resetPasswordForEmail(email);
  writeAudit('reset_password', id, error ? 'Failed: '+error.message : 'Reset email sent');
  if(error) alert(error.message);
}
async function deleteUser(id){
  if(!confirm('Delete this member\'s profile data? This cannot be undone from the browser.')) return;
  const { error } = await sb.from('profiles').delete().eq('id', id);
  if(error){ alert(error.message); return; }
  writeAudit('delete_profile', id, 'Profile data deleted (see README about full account deletion)');
}

/* ============================================================
   ADMIN — live stats, login monitoring, audit log
   ============================================================ */
function renderAdminStats(){
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

  document.getElementById('adminStats2').innerHTML = [
    {n: newToday, l:'New registrations today'},
    {n: newWeek, l:'Registrations this week'},
    {n: newMonth, l:'Registrations this month'},
    {n: '—', l:'Website visits (see audit/SQL)'},
  ].map(s=>`<div class="stat glass"><div class="n">${s.n}</div><div class="l">${s.l}</div></div>`).join('');

  fetchLoginMonitor();
  fetchAuditLog();
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
async function handleQuickAction(action, qaWrap){
  if(qaWrap) Array.from(qaWrap.children).forEach(b=>b.disabled=true);
  if(action==='go_announcements'){ scrollToId('announcements'); return; }
  if(action==='go_events'){ scrollToId('events'); return; }
  if(action==='go_news'){ scrollToId('news'); return; }
  if(action==='go_dashboard'){ scrollToId('dashboard'); return; }
  if(action==='go_admin'){ scrollToId('admin'); return; }
  if(action==='cancel_admin_action'){ solisCtx.pendingConfirm=null; addBotMsg('Okay, no changes made.'); return; }
  const m = action.match(/^(suspend|delete|promote|demote)_(.+)$/);
  if(m){ const reply = await executeAdminAction(m[1], m[2]); addBotMsg(reply.text); solisCtx.pendingConfirm=null; return; }
}
function askSuggestion(text){ document.getElementById('solisInput').value=text; sendSolis(); }
function openSolis(){ document.getElementById('solisWindow').classList.remove('minimized'); document.getElementById('solisWindow').classList.add('open'); document.getElementById('solisMinibar').classList.add('hidden'); document.getElementById('solisInput').focus(); solisCtx.chatOpenedOnce=true; clearSolisBadge(); }
function closeSolis(){ document.getElementById('solisWindow').classList.remove('open'); document.getElementById('solisMinibar').classList.add('hidden'); }
function minimizeSolis(){ document.getElementById('solisWindow').classList.remove('open'); document.getElementById('solisMinibar').classList.remove('hidden'); }
function restoreSolis(){ openSolis(); }
function clearSolisChat(){ document.getElementById('solisBody').innerHTML=''; solisCtx.history=[]; solisCtx.lastTopic=null; solisCtx.pendingConfirm=null; renderWelcome(); }
function solisIsVisible(){ return document.getElementById('solisWindow').classList.contains('open'); }
function clearSolisBadge(){ solisUnread=0; document.getElementById('solisBtnBadge').classList.add('hidden'); document.getElementById('solisMiniBadge').style.display='none'; }
function bumpSolisBadge(){ solisUnread++; const b1=document.getElementById('solisBtnBadge'); b1.textContent=solisUnread; b1.classList.remove('hidden'); const b2=document.getElementById('solisMiniBadge'); b2.style.display='flex'; b2.textContent=solisUnread; }
function updateSolisStatusLine(){
  const labelMap = {home:'Home', announcements:'Announcements', events:'Events', news:'News', dashboard:'Dashboard', admin:'Admin'};
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
  ['home','announcements','events','news','dashboard','admin'].forEach(id=>{
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
