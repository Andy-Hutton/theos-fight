const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const app = express();
const client = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const searchCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function makeCacheKey(diagnosis, location, equipment) {
  return [diagnosis, location, ...equipment.slice().sort()].join('|').toLowerCase();
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://sibforms.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "api.qrserver.com"],
      connectSrc: ["'self'", "https://sibforms.com", "https://d98e95d1.sibforms.com"],
      frameSrc: ["'self'", "https://sibforms.com", "https://d98e95d1.sibforms.com"],
    }
  }
}));

const searchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many searches. Please wait a few minutes and try again.' }
});

const draftLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests. Please wait a few minutes and try again.' }
});

app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));

function sanitiseText(text, maxLength = 500) {
  if (!text || typeof text !== 'string') return '';
  return xss(text.trim().slice(0, maxLength));
}

function validateRequest(body) {
  const { childName, childAge, diagnosis, location } = body;
  if (!childName || !childAge || !diagnosis || !location) return false;
  if (typeof childName !== 'string' || typeof diagnosis !== 'string' || typeof location !== 'string') return false;
  return true;
}

function parseGrantsFromResponse(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

async function validateGrantUrls(grants) {
  const validatedGrants = await Promise.all(grants.map(async (grant) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(grant.url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow'
      });
      
      clearTimeout(timeout);
      
      if (response.ok || response.status === 405) {
        return { ...grant, urlVerified: true };
      } else {
        return { ...grant, url: extractBaseUrl(grant.url), urlVerified: false };
      }
    } catch (err) {
      return { ...grant, url: extractBaseUrl(grant.url), urlVerified: false };
    }
  }));
  
  return validatedGrants;
}

async function captureGrantsToSupabase(grants) {
  for (const grant of grants) {
    await supabase.from('grants').upsert({
      name: grant.name,
      organisation: grant.organisation,
      description: grant.description || null,
      amount: grant.amount || null,
      url: grant.url || null,
      email: grant.email || null,
      tags: grant.tags || [],
      eligibility: grant.eligibility || null,
    }, { onConflict: 'name,organisation', ignoreDuplicates: true });
  }
}

function extractBaseUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}
app.post('/search-grants', searchLimiter, async (req, res) => {
  if (!validateRequest(req.body)) {
    return res.status(400).json({ success: false, error: 'Please fill in all required fields.' });
  }

  const childName = sanitiseText(req.body.childName, 50);
  const childAge = sanitiseText(req.body.childAge, 10);
  const diagnosis = sanitiseText(req.body.diagnosis, 200);
  const location = sanitiseText(req.body.location, 100);
  const equipment = Array.isArray(req.body.equipment)
    ? req.body.equipment.slice(0, 10).map(e => sanitiseText(e, 50))
    : [];
  const context = sanitiseText(req.body.context, 500);

  const cacheKey = makeCacheKey(diagnosis, location, equipment);
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json({ success: true, grants: cached.grants });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a UK grant specialist helping families with disabled children find financial support for specialist equipment. Search for real UK grants for this family. Child name: ${childName}. Age: ${childAge}. Diagnosis: ${diagnosis}. Location: ${location}. Equipment needed: ${equipment.join(', ')}. Additional context: ${context || 'None provided'}. Return ONLY a raw JSON array with no markdown formatting, no code blocks, no backticks. Just the pure JSON array like this: [{"name": "Grant name", "organisation": "Organisation name", "amount": "Up to X000", "eligibility": 85, "description": "2-3 sentence description", "tags": ["tag1", "tag2"], "url": "https://real-url.org", "email": "applications@example.org"}] Only use stable homepage or main section URLs for reputable UK organisations. Never use deep links or specific campaign pages that may change.`
      }]
    });

    const grants = parseGrantsFromResponse(message.content[0].text);
const validatedGrants = await validateGrantUrls(grants);
searchCache.set(cacheKey, { grants: validatedGrants, timestamp: Date.now() });
captureGrantsToSupabase(validatedGrants).catch(err => console.error('Supabase capture:', err.message));
res.json({ success: true, grants: validatedGrants });

  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
});

app.post('/draft-application', draftLimiter, async (req, res) => {
  if (!validateRequest(req.body)) {
    return res.status(400).json({ success: false, error: 'Missing required information.' });
  }

  const childName = sanitiseText(req.body.childName, 50);
  const childAge = sanitiseText(req.body.childAge, 10);
  const diagnosis = sanitiseText(req.body.diagnosis, 200);
  const location = sanitiseText(req.body.location, 100);
  const equipment = Array.isArray(req.body.equipment)
    ? req.body.equipment.slice(0, 10).map(e => sanitiseText(e, 50))
    : [];
  const grantName = sanitiseText(req.body.grantName, 100);
const organisation = sanitiseText(req.body.organisation, 100);
const childDescription = sanitiseText(req.body.childDescription, 600);

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{
        role: 'user',
       content: `Write a heartfelt professional grant application letter for a UK family. Grant: ${grantName} by ${organisation}. Child name: ${childName}. Age: ${childAge}. Diagnosis: ${diagnosis}. Location: ${location}. Equipment needed: ${equipment.join(', ')}.About this child in the family's own words: ${childDescription || 'Not provided'}. IMPORTANT: Base all descriptions of the child entirely on what the family has told you above. Never assume abilities, emotions, or behaviours that have not been mentioned. If no description was provided, describe only the factual details given. Write a complete ready-to-send letter, warm and compelling. Use [PARENT NAME] as placeholder for parent name. Do not use any markdown formatting, asterisks, bold, or special characters in the letter. Plain text only. Format the letter for email - do not include a postal address header block. Start with the date on a single line, then a blank line, then the greeting. Keep it clean and modern..`
      }]
    });

    res.json({ success: true, draft: message.content[0].text });

  } catch (error) {
    console.error('Draft error:', error.message);
    res.status(500).json({ success: false, error: 'Could not generate letter. Please try again.' });
  }
});
function adminAuth(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin not configured' });
  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorised' });
  next();
}

app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Grant Admin — Theo's Fight</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;background:#f0f4f8;color:#1a2b3c;min-height:100vh;}
  .gate{display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .gate-card{background:#fff;border-radius:12px;padding:40px;width:100%;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,0.1);}
  .gate-title{font-size:1.3rem;font-weight:700;margin-bottom:6px;color:#0d1117;}
  .gate-sub{font-size:0.85rem;color:#8a9aaa;margin-bottom:24px;}
  input[type=password]{width:100%;padding:12px 14px;border:1.5px solid #d0dce8;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:0.95rem;outline:none;margin-bottom:12px;}
  input[type=password]:focus{border-color:#2a9fd6;}
  .btn{padding:12px 20px;border:none;border-radius:8px;font-family:'DM Sans',sans-serif;font-size:0.9rem;font-weight:600;cursor:pointer;transition:background 0.2s;}
  .btn-primary{background:#2a9fd6;color:#fff;width:100%;}
  .btn-primary:hover{background:#1e87bf;}
  .btn-sm{padding:7px 14px;font-size:0.8rem;}
  .btn-success{background:#2ecc71;color:#fff;}
  .btn-success:hover{background:#27ae60;}
  .btn-outline{background:transparent;border:1.5px solid #d0dce8;color:#1a2b3c;}
  .btn-outline:hover{border-color:#2a9fd6;color:#2a9fd6;}
  .btn-danger{background:transparent;border:1.5px solid #ffb3b3;color:#e03b1f;}
  .btn-danger:hover{background:#ffeaea;}
  .err{color:#e03b1f;font-size:0.82rem;margin-top:8px;display:none;}
  header{background:#0d1117;color:#fff;padding:16px 32px;display:flex;align-items:center;justify-content:space-between;}
  header h1{font-size:1.1rem;font-weight:700;}header span{color:#2a9fd6;}
  .stats{display:flex;gap:16px;padding:20px 32px;background:#fff;border-bottom:1px solid #e8eef2;}
  .stat{text-align:center;padding:12px 24px;border-radius:8px;background:#f8fafc;border:1px solid #e8eef2;min-width:110px;}
  .stat-num{font-size:1.8rem;font-weight:700;color:#0d1117;}
  .stat-num.blue{color:#2a9fd6;} .stat-num.green{color:#2ecc71;} .stat-num.orange{color:#f39c12;}
  .stat-label{font-size:0.75rem;color:#8a9aaa;text-transform:uppercase;letter-spacing:0.05em;}
  .filters{padding:16px 32px;display:flex;gap:8px;}
  .filter-btn{padding:8px 18px;border:1.5px solid #d0dce8;border-radius:20px;background:#fff;font-family:'DM Sans',sans-serif;font-size:0.82rem;font-weight:600;cursor:pointer;transition:all 0.15s;color:#5a7a8a;}
  .filter-btn.active{background:#2a9fd6;border-color:#2a9fd6;color:#fff;}
  .grants{padding:0 32px 32px;display:flex;flex-direction:column;gap:12px;}
  .grant-row{background:#fff;border-radius:10px;padding:20px 24px;border:1px solid #e8eef2;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:start;}
  .grant-name{font-size:0.95rem;font-weight:700;color:#0d1117;margin-bottom:2px;}
  .grant-org{font-size:0.82rem;color:#5a7a8a;margin-bottom:8px;}
  .grant-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:0.78rem;color:#8a9aaa;margin-bottom:8px;}
  .grant-meta a{color:#2a9fd6;text-decoration:none;} .grant-meta a:hover{text-decoration:underline;}
  .grant-tags{display:flex;gap:4px;flex-wrap:wrap;}
  .tag{background:#f0f6fb;color:#1a6fa0;font-size:0.72rem;font-weight:600;padding:2px 8px;border-radius:10px;}
  .badge{display:inline-block;padding:3px 10px;border-radius:10px;font-size:0.72rem;font-weight:700;}
  .badge-unverified{background:#fff8e6;color:#b07d00;}
  .badge-verified{background:#eafaf1;color:#1a7a40;}
  .actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;}
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:100;align-items:center;justify-content:center;padding:20px;}
  .modal-bg.open{display:flex;}
  .modal{background:#fff;border-radius:12px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 16px 48px rgba(0,0,0,0.2);}
  .modal-head{padding:18px 24px;border-bottom:1px solid #e8eef2;display:flex;justify-content:space-between;align-items:center;}
  .modal-head h2{font-size:1rem;font-weight:700;}
  .modal-body{padding:24px;display:flex;flex-direction:column;gap:14px;}
  .field{display:flex;flex-direction:column;gap:4px;}
  .field label{font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#5a7a8a;}
  .field input,.field textarea{padding:10px 12px;border:1.5px solid #d0dce8;border-radius:7px;font-family:'DM Sans',sans-serif;font-size:0.9rem;outline:none;}
  .field input:focus,.field textarea:focus{border-color:#2a9fd6;}
  .field textarea{resize:vertical;min-height:80px;}
  .modal-foot{padding:16px 24px;border-top:1px solid #e8eef2;display:flex;gap:8px;justify-content:flex-end;}
  .loading{text-align:center;padding:48px;color:#8a9aaa;}
  .empty{text-align:center;padding:48px;color:#8a9aaa;background:#fff;border-radius:10px;border:1px solid #e8eef2;}
  #logoutBtn{background:rgba(255,255,255,0.1);border:none;color:rgba(255,255,255,0.6);padding:8px 16px;border-radius:6px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:0.82rem;}
  #logoutBtn:hover{background:rgba(255,255,255,0.2);color:#fff;}
</style>
</head>
<body>

<div class="gate" id="gate">
  <div class="gate-card">
    <div class="gate-title">Theo's Fight <span style="color:#2a9fd6">Admin</span></div>
    <div class="gate-sub">Grant review dashboard</div>
    <input type="password" id="pwInput" placeholder="Password" onkeydown="if(event.key==='Enter')login()">
    <button class="btn btn-primary" onclick="login()">Log in</button>
    <div class="err" id="pwErr">Incorrect password</div>
  </div>
</div>

<div id="app" style="display:none;">
  <header>
    <h1>Theo's <span>Fight</span> — Grant Admin</h1>
    <button id="logoutBtn" onclick="logout()">Log out</button>
  </header>
  <div class="stats" id="statsBar"></div>
  <div class="filters">
    <button class="filter-btn active" onclick="setFilter('all',this)">All</button>
    <button class="filter-btn" onclick="setFilter('unverified',this)">Unverified</button>
    <button class="filter-btn" onclick="setFilter('verified',this)">Verified</button>
  </div>
  <div class="grants" id="grantsList"><div class="loading">Loading grants...</div></div>
</div>

<div class="modal-bg" id="editModal">
  <div class="modal">
    <div class="modal-head"><h2>Edit Grant</h2><button class="btn btn-sm btn-outline" onclick="closeEdit()">✕ Close</button></div>
    <div class="modal-body">
      <input type="hidden" id="editId">
      <div class="field"><label>Name</label><input id="editName" type="text"></div>
      <div class="field"><label>Organisation</label><input id="editOrg" type="text"></div>
      <div class="field"><label>Amount</label><input id="editAmount" type="text" placeholder="e.g. Up to £500"></div>
      <div class="field"><label>URL</label><input id="editUrl" type="text"></div>
      <div class="field"><label>Email</label><input id="editEmail" type="text"></div>
      <div class="field"><label>Eligibility %</label><input id="editEligibility" type="number" min="0" max="100"></div>
      <div class="field"><label>Tags (comma-separated)</label><input id="editTags" type="text" placeholder="wheelchair, mobility, sensory"></div>
      <div class="field"><label>Description</label><textarea id="editDesc"></textarea></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-sm btn-outline" onclick="closeEdit()">Cancel</button>
      <button class="btn btn-sm btn-primary" onclick="saveEdit()">Save changes</button>
    </div>
  </div>
</div>

<script>
  let key = '';
  let allGrants = [];
  let grantsMap = {};
  let currentFilter = 'all';

  function login() {
    key = document.getElementById('pwInput').value;
    fetch('/admin/api/grants?filter=all', { headers: { 'x-admin-key': key } })
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(data => {
        document.getElementById('gate').style.display = 'none';
        document.getElementById('app').style.display = 'block';
        allGrants = data.grants;
        allGrants.forEach(g => grantsMap[g.id] = g);
        renderStats();
        renderGrants();
      })
      .catch(() => {
        document.getElementById('pwErr').style.display = 'block';
      });
  }

  function logout() {
    key = '';
    document.getElementById('gate').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('pwInput').value = '';
  }

  function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrants();
  }

  function renderStats() {
    const total = allGrants.length;
    const verified = allGrants.filter(g => g.verified).length;
    const unverified = total - verified;
    document.getElementById('statsBar').innerHTML = \`
      <div class="stat"><div class="stat-num blue">\${total}</div><div class="stat-label">Total grants</div></div>
      <div class="stat"><div class="stat-num orange">\${unverified}</div><div class="stat-label">Unverified</div></div>
      <div class="stat"><div class="stat-num green">\${verified}</div><div class="stat-label">Verified</div></div>
    \`;
  }

  function renderGrants() {
    const filtered = allGrants.filter(g => {
      if (currentFilter === 'unverified') return !g.verified;
      if (currentFilter === 'verified') return g.verified;
      return true;
    });
    const list = document.getElementById('grantsList');
    if (!filtered.length) { list.innerHTML = '<div class="empty">No grants in this category.</div>'; return; }
    list.innerHTML = filtered.map(g => \`
      <div class="grant-row" id="row-\${g.id}">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px;">
            <div class="grant-name">\${esc(g.name)}</div>
            <span class="badge \${g.verified ? 'badge-verified' : 'badge-unverified'}">\${g.verified ? '✅ Verified' : '⏳ Unverified'}</span>
          </div>
          <div class="grant-org">\${esc(g.organisation)}</div>
          <div class="grant-meta">
            \${g.amount ? '<span>💰 ' + esc(g.amount) + '</span>' : ''}
            \${g.eligibility ? '<span>🎯 ' + g.eligibility + '% match</span>' : ''}
            \${g.url ? '<a href="' + esc(g.url) + '" target="_blank" rel="noopener">🔗 ' + esc(g.url) + '</a>' : ''}
            \${g.email ? '<span>📧 ' + esc(g.email) + '</span>' : ''}
          </div>
          \${g.tags && g.tags.length ? '<div class="grant-tags">' + g.tags.map(t => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' : ''}
        </div>
        <div class="actions">
          \${!g.verified ? '<button class="btn btn-sm btn-success" onclick="verify(\'' + g.id + '\')">✅ Verify</button>' : '<button class="btn btn-sm btn-outline" onclick="unverify(\'' + g.id + '\')">↩ Unverify</button>'}
          <button class="btn btn-sm btn-outline" onclick="openEdit('\${g.id}')">✏️ Edit</button>
          <button class="btn btn-sm btn-danger" onclick="remove('\${g.id}')">🗑️ Remove</button>
        </div>
      </div>
    \`).join('');
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function verify(id) {
    await patchGrant(id, { verified: true });
    const g = allGrants.find(g => g.id === id);
    if (g) g.verified = true;
    renderStats(); renderGrants();
  }

  async function unverify(id) {
    await patchGrant(id, { verified: false });
    const g = allGrants.find(g => g.id === id);
    if (g) g.verified = false;
    renderStats(); renderGrants();
  }

  async function remove(id) {
    if (!confirm('Remove this grant? It will be marked inactive.')) return;
    await patchGrant(id, { active: false });
    allGrants = allGrants.filter(g => g.id !== id);
    renderStats(); renderGrants();
  }

  function openEdit(id) {
    const grant = grantsMap[id];
    if (!grant) return;
    document.getElementById('editId').value = grant.id;
    document.getElementById('editName').value = grant.name || '';
    document.getElementById('editOrg').value = grant.organisation || '';
    document.getElementById('editAmount').value = grant.amount || '';
    document.getElementById('editUrl').value = grant.url || '';
    document.getElementById('editEmail').value = grant.email || '';
    document.getElementById('editEligibility').value = grant.eligibility || '';
    document.getElementById('editTags').value = (grant.tags || []).join(', ');
    document.getElementById('editDesc').value = grant.description || '';
    document.getElementById('editModal').classList.add('open');
  }

  function closeEdit() { document.getElementById('editModal').classList.remove('open'); }

  async function saveEdit() {
    const id = document.getElementById('editId').value;
    const updates = {
      name: document.getElementById('editName').value,
      organisation: document.getElementById('editOrg').value,
      amount: document.getElementById('editAmount').value,
      url: document.getElementById('editUrl').value,
      email: document.getElementById('editEmail').value,
      eligibility: parseInt(document.getElementById('editEligibility').value) || null,
      tags: document.getElementById('editTags').value.split(',').map(t => t.trim()).filter(Boolean),
      description: document.getElementById('editDesc').value,
    };
    await patchGrant(id, updates);
    const idx = allGrants.findIndex(g => g.id === id);
    if (idx > -1) { allGrants[idx] = { ...allGrants[idx], ...updates }; grantsMap[id] = allGrants[idx]; }
    closeEdit(); renderGrants();
  }

  async function patchGrant(id, updates) {
    await fetch('/admin/api/grants/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(updates)
    });
  }
</script>
</body>
</html>`);
});

app.get('/admin/api/grants', adminAuth, async (req, res) => {
  const filter = req.query.filter;
  let query = supabase.from('grants').select('*').eq('active', true).order('created_at', { ascending: false });
  if (filter === 'unverified') query = query.eq('verified', false);
  if (filter === 'verified') query = query.eq('verified', true);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ grants: data });
});

app.patch('/admin/api/grants/:id', adminAuth, async (req, res) => {
  const allowed = ['name', 'organisation', 'description', 'amount', 'url', 'email', 'tags', 'eligibility', 'verified', 'active'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { error } = await supabase.from('grants').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/report-grant', (req, res) => {
  const grantName = sanitiseText(req.body.grantName, 100);
  const organisation = sanitiseText(req.body.organisation, 100);
  console.log(`⚠️ GRANT REPORTED: ${grantName} by ${organisation} - ${new Date().toISOString()}`);
  res.json({ success: true });
});

app.post('/submit-feedback', async (req, res) => {
  const name = sanitiseText(req.body.name, 50) || 'Anonymous';
  const location = sanitiseText(req.body.location, 100);
  const equipment = sanitiseText(req.body.equipment, 200);
  const experience = sanitiseText(req.body.experience, 1000);
  const rating = parseInt(req.body.rating) || 0;

  if (!experience) {
    return res.status(400).json({ success: false });
  }

  const stars = '⭐'.repeat(rating);

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    transporter.verify(function(error, success) {
      if (error) {
        console.error('SMTP Error:', error);
      } else {
        console.log('SMTP connection verified');
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'hello@theosfight.co.uk',
      subject: `⭐ New Theo's Fight feedback from ${name}`,
      text: `
NEW FEEDBACK SUBMISSION
=======================
Name: ${name}
Location: ${location || 'Not provided'}
Equipment: ${equipment || 'Not provided'}
Rating: ${stars} (${rating}/5)
Date: ${new Date().toLocaleString('en-GB')}

Their experience:
${experience}

=======================
To approve and add to the Stories page, copy the above into testimonials.html
      `
    });

    console.log(`⭐ Feedback received from ${name} and emailed`);
    res.json({ success: true });

  } catch (error) {
    console.error('Feedback email error:', error.message);
    console.log(`⭐ Feedback from ${name}: ${experience}`);
    res.json({ success: true });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Theo's Fight running securely on http://localhost:${PORT}`);
});