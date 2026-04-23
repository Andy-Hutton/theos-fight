const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss');
require('dotenv').config();
const app = express();
const client = new Anthropic();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
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

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a UK grant specialist helping families with disabled children find financial support for specialist equipment. Search for real UK grants for this family. Child name: ${childName}. Age: ${childAge}. Diagnosis: ${diagnosis}. Location: ${location}. Equipment needed: ${equipment.join(', ')}. Additional context: ${context || 'None provided'}. Return ONLY a raw JSON array with no markdown formatting, no code blocks, no backticks. Just the pure JSON array like this: [{"name": "Grant name", "organisation": "Organisation name", "amount": "Up to X000", "eligibility": 85, "description": "2-3 sentence description", "tags": ["tag1", "tag2"], "url": "https://real-url.org", "email": "applications@example.org"}]`
      }]
    });

    const grants = parseGrantsFromResponse(message.content[0].text);
    res.json({ success: true, grants });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Theo's Fight running securely on http://localhost:${PORT}`);
});