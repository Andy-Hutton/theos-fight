const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  res.send(fs.readFileSync(path.join(__dirname, 'admin-template.html'), 'utf8'));
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
// ORGANISATION GRANTS — private tool, separate from the family finder
const ORG_COOKIE = 'org_session';
const ORG_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const orgLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many attempts. Please wait a few minutes and try again.' }
});

const orgSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many searches. Please wait a few minutes and try again.' }
});

const orgRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, error: 'Too many requests. Please try again later.' }
});

function signOrgSession(expires) {
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(String(expires)).digest('hex');
  return `${expires}.${sig}`;
}

function orgSessionValid(req) {
  if (!process.env.SESSION_SECRET) return false;
  const raw = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${ORG_COOKIE}=`));
  if (!raw) return false;
  const [expires, sig] = raw.slice(ORG_COOKIE.length + 1).split('.');
  if (!expires || !sig) return false;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(expires).digest('hex');
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(expires) > Date.now();
}

function orgAuth(req, res, next) {
  if (!orgSessionValid(req)) return res.status(401).json({ success: false, error: 'Please log in again.' });
  next();
}

function parseOrgGrants(text) {
  const end = text.lastIndexOf(']');
  if (end === -1) throw new Error('No JSON array in response');
  // Try each opening bracket in turn — any prose before the array can contain
  // brackets of its own, so the first bracket is not always the right one.
  let start = -1;
  while ((start = text.indexOf('[', start + 1)) !== -1 && start < end) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      // not the start of the array — keep looking
    }
  }
  throw new Error('No JSON array in response');
}

function textFromResponse(response) {
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

app.get('/organisation-grants', (req, res) => {
  const template = orgSessionValid(req) ? 'org-grants-template.html' : 'org-login-template.html';
  res.send(fs.readFileSync(path.join(__dirname, template), 'utf8'));
});

app.post('/organisation-grants/login', orgLoginLimiter, (req, res) => {
  if (!process.env.ORG_PASSWORD || !process.env.SESSION_SECRET) {
    return res.status(503).json({ success: false, error: 'Organisation login is not set up yet.' });
  }
  const supplied = Buffer.from(typeof req.body.password === 'string' ? req.body.password : '');
  const expected = Buffer.from(process.env.ORG_PASSWORD);
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!ok) {
    return res.status(401).json({ success: false, error: "That password isn't right. Try again, or request access below." });
  }
  const expires = Date.now() + ORG_SESSION_MS;
  res.cookie(ORG_COOKIE, signOrgSession(expires), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: ORG_SESSION_MS,
    path: '/organisation-grants'
  });
  res.json({ success: true });
});

app.post('/organisation-grants/request-access', orgRequestLimiter, async (req, res) => {
  const orgName = sanitiseText(req.body.orgName, 120);
  const contactName = sanitiseText(req.body.contactName, 80);
  const email = sanitiseText(req.body.email, 120);

  if (!orgName || !contactName || !email) {
    return res.status(400).json({ success: false, error: 'Please fill in all three fields.' });
  }

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

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: 'hello@theosfight.co.uk',
      subject: `🏛️ Organisation grants access request — ${orgName}`,
      text: `
ORGANISATION ACCESS REQUEST
===========================
Organisation: ${orgName}
Contact: ${contactName}
Email: ${email}
Date: ${new Date().toLocaleString('en-GB')}

===========================
To approve, reply with the organisation access password.
      `
    });

    console.log(`🏛️ Org access requested by ${orgName}`);
  } catch (error) {
    console.error('Org access request email error:', error.message);
    console.log(`🏛️ Org access request from ${orgName} (${contactName}, ${email})`);
  }

  res.json({ success: true });
});

app.post('/organisation-grants/search', orgSearchLimiter, orgAuth, async (req, res) => {
  const orgName = sanitiseText(req.body.orgName, 120);
  const orgType = sanitiseText(req.body.orgType, 60);
  const charityNumber = sanitiseText(req.body.charityNumber, 20);
  const region = sanitiseText(req.body.region, 40);
  const town = sanitiseText(req.body.town, 100);
  const beneficiaries = sanitiseText(req.body.beneficiaries, 30);
  const turnover = sanitiseText(req.body.turnover, 30);
  const staff = sanitiseText(req.body.staff, 30);
  const amount = sanitiseText(req.body.amount, 30);
  const fundingFor = Array.isArray(req.body.fundingFor)
    ? req.body.fundingFor.slice(0, 10).map(f => sanitiseText(f, 40)).filter(Boolean)
    : [];
  const detail = sanitiseText(req.body.detail, 800);

  if (!orgName || !orgType || !region || !town || !beneficiaries || !staff || !amount || !fundingFor.length || !detail) {
    return res.status(400).json({ success: false, error: 'Please fill in all the fields above.' });
  }

  try {
    // Streamed, not a plain create: a long answer keeps the connection idle
    // long enough to be dropped part-way through.
    const message = await client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 6000,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: `You are a UK grant specialist helping organisations that support children with additional needs find grant funding. Find real UK grant funders this organisation is genuinely eligible to apply to. Organisation: ${orgName}. Legal structure: ${orgType}. Charity number: ${charityNumber || 'Not provided'}. Nation or region: ${region}. Town, city or borough: ${town}. People supported each year: ${beneficiaries}. Annual turnover: ${turnover || 'Not provided'}. Staff: ${staff}. Amount sought: ${amount}. What the grant would fund: ${fundingFor.join(', ')}. In their own words: ${detail}. IMPORTANT: eligibility depends heavily on legal structure and geography — only return funders this legal structure can actually apply to, that fund this region, and whose award sizes fit the amount sought. Go beyond the obvious national funders: include smaller regional trusts, local community foundations covering ${town} and ${region}, and devolved-nation funders where they apply. Return 15 to 20 funders, ranked with the strongest fit first. Return ONLY a raw JSON array with no commentary, no markdown formatting, no code blocks and no backticks. Just the pure JSON array like this: [{"name": "Grant name", "organisation": "Funder name", "amount": "Up to X000", "eligibility": 85, "description": "2-3 sentence description of what they fund and why this organisation fits", "tags": ["tag1", "tag2"], "url": "https://real-url.org", "email": "grants@example.org"}] Only use stable homepage or main section URLs for reputable UK funders. Never use deep links or specific campaign pages that may change.`
      }]
    }).finalMessage();

    const usage = message.usage || {};
    console.log(`🏛️ Org search: ${usage.input_tokens} in, ${usage.output_tokens} out, stop ${message.stop_reason}`);

    const grants = parseOrgGrants(textFromResponse(message));
    const validatedGrants = await validateGrantUrls(grants);
    res.json({ success: true, grants: validatedGrants });

  } catch (error) {
    console.error('Org search error:', error.message);
    res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Theo's Fight running securely on http://localhost:${PORT}`);
});