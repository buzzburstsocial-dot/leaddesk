import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHmac, createHash, randomBytes } from 'crypto';
import cookieParser from 'cookie-parser';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe  = new Stripe(process.env.STRIPE_SECRET_KEY);

const COOKIE_SECRET = process.env.COOKIE_SECRET || (() => {
  const s = randomBytes(32).toString('hex');
  console.warn('\n  ⚠  COOKIE_SECRET not set — sessions will not survive restarts.\n');
  return s;
})();

app.use(express.json());
app.use(cookieParser());

// ── Data persistence ────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const AGENTS_FILE = join(DATA_DIR, 'agents.json');

function loadAgents() {
  if (!existsSync(AGENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(AGENTS_FILE, 'utf8')); } catch { return {}; }
}
function saveAgents(data) { writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2)); }

function getConfig(sessionKey) {
  const agents = loadAgents();
  if (agents[sessionKey]) return agents[sessionKey];
  const config = {
    agentId:      randomBytes(8).toString('hex'),
    businessName: '',
    description:  '',
    services:     '',
    notifyEmail:  '',
    faqs:         [],
    leads:        [],
  };
  agents[sessionKey] = config;
  saveAgents(agents);
  return config;
}

function saveConfig(sessionKey, updates) {
  const agents = loadAgents();
  const existing = agents[sessionKey] || getConfig(sessionKey);
  // Protect stable fields
  agents[sessionKey] = { ...existing, ...updates, agentId: existing.agentId, leads: existing.leads };
  saveAgents(agents);
  return agents[sessionKey];
}

function getConfigByAgentId(agentId) {
  return Object.values(loadAgents()).find(a => a.agentId === agentId) || null;
}

function saveLead(agentId, lead) {
  const agents = loadAgents();
  const entry = Object.entries(agents).find(([, v]) => v.agentId === agentId);
  if (!entry) return;
  const [key, config] = entry;
  config.leads = [lead, ...(config.leads || [])];
  agents[key] = config;
  saveAgents(agents);
}

function deleteLead(sessionKey, leadId) {
  const agents = loadAgents();
  if (!agents[sessionKey]) return;
  agents[sessionKey].leads = (agents[sessionKey].leads || []).filter(l => l.id !== leadId);
  saveAgents(agents);
}

// ── Email ───────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendLeadEmail(notifyEmail, lead, businessName) {
  if (!process.env.SMTP_USER || !notifyEmail) return;
  try {
    await mailer.sendMail({
      from:    `LeadDesk <${process.env.SMTP_USER}>`,
      to:      notifyEmail,
      subject: `🎉 New lead: ${lead.name} — ${businessName || 'your business'}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;color:#111827">
          <div style="background:#7c3aed;padding:20px 24px;border-radius:10px 10px 0 0">
            <h2 style="color:#fff;margin:0;font-size:18px">🎉 New Lead — LeadDesk</h2>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 10px 10px">
            <p style="margin:0 0 16px">Someone just expressed interest through your <strong>${businessName || 'business'}</strong> chat widget.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:10px 12px;background:#f5f3ff;border-radius:6px 6px 0 0;font-size:13px;color:#6b7280;font-weight:600">NAME</td></tr>
              <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;border-top:none;font-size:15px;border-radius:0 0 6px 6px">${lead.name}</td></tr>
            </table>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:10px 12px;background:#f5f3ff;border-radius:6px 6px 0 0;font-size:13px;color:#6b7280;font-weight:600">EMAIL</td></tr>
              <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;border-top:none;font-size:15px;border-radius:0 0 6px 6px"><a href="mailto:${lead.email}" style="color:#7c3aed">${lead.email}</a></td></tr>
            </table>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr><td style="padding:10px 12px;background:#f5f3ff;border-radius:6px 6px 0 0;font-size:13px;color:#6b7280;font-weight:600">THEIR MESSAGE</td></tr>
              <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;border-top:none;font-size:15px;border-radius:0 0 6px 6px">${lead.message}</td></tr>
            </table>
            <p style="margin:0;font-size:13px;color:#6b7280">Captured ${new Date(lead.timestamp).toLocaleString()} via LeadDesk</p>
          </div>
        </div>
      `,
    });
  } catch (err) {
    console.error('Lead email failed:', err.message);
  }
}

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt(config) {
  const biz = config.businessName || 'this business';
  let p = `You are a friendly AI assistant for ${biz}. Your job is to answer visitor questions and connect interested people with the business.`;

  if (config.description) p += `\n\nAbout ${biz}:\n${config.description}`;
  if (config.services)    p += `\n\nServices offered:\n${config.services}`;

  if (config.faqs?.length > 0) {
    p += '\n\nFrequently asked questions:\n';
    config.faqs.forEach(f => {
      if (f.question && f.answer) p += `Q: ${f.question}\nA: ${f.answer}\n\n`;
    });
  }

  p += `\n\nLead capture instructions:
- Answer questions helpfully and concisely
- When a visitor asks about pricing, quotes, availability, booking, or says they're interested in hiring or using the services, provide helpful information and then naturally ask for their contact details: "I'd love to get ${biz} in touch with you — what's your name and email address?"
- Once you have confirmed BOTH name AND email from the visitor in the conversation, end your response with exactly: <<<LEAD:Full Name|email@example.com>>>
- Only include <<<LEAD:...>>> once per conversation, only after you have both pieces of contact info
- After capturing their details, confirm you'll pass them on and ask if there's anything else you can help with
- For general questions that don't involve interest in the business, just answer helpfully — don't push for contact info
- Never fabricate services, prices, or information not provided above`;

  return p;
}

// ── Auth middleware ─────────────────────────────────────────────────────────
function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireAuth(req, res, next) {
  if (isLocalhost(req)) { req.isLocalhost = true; req.sessionKey = 'localhost-dev'; return next(); }
  const token = req.cookies?.ld_session;
  if (!token) return res.redirect('/');
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) throw new Error('malformed');
    const data = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = createHmac('sha256', COOKIE_SECRET).update(data).digest('base64url');
    if (sig !== expected) throw new Error('bad sig');
    const { exp } = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() > exp) throw new Error('expired');
    req.sessionKey  = createHash('sha256').update(data).digest('hex').slice(0, 16);
    req.isLocalhost = false;
    next();
  } catch {
    res.clearCookie('ld_session');
    res.redirect('/');
  }
}

function setSessionCookie(res, email, maxAgeDays = 30) {
  const exp  = Date.now() + maxAgeDays * 24 * 60 * 60 * 1000;
  const data = Buffer.from(JSON.stringify({ email, exp })).toString('base64url');
  const sig  = createHmac('sha256', COOKIE_SECRET).update(data).digest('base64url');
  res.cookie('ld_session', `${data}.${sig}`, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    maxAge: maxAgeDays * 24 * 60 * 60 * 1000, sameSite: 'lax',
  });
}

// ── Pages ───────────────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.sendFile(join(__dirname, 'public', 'landing.html')));
app.get('/dashboard',  requireAuth, (req, res) => res.sendFile(join(__dirname, 'public', 'dashboard.html')));
app.get('/chat-frame', (req, res) => res.sendFile(join(__dirname, 'public', 'chat-frame.html')));
app.get('/widget.js',  (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(join(__dirname, 'public', 'widget.js'));
});

// ── Stripe ──────────────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${req.protocol}://${req.get('host')}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/');
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.status !== 'complete') return res.redirect('/');
    setSessionCookie(res, session.customer_details?.email || '');
    res.redirect('/dashboard');
  } catch { res.redirect('/'); }
});

// ── Admin bypass ─────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const key = process.env.ADMIN_SECRET_KEY;
  if (!key || req.query.key !== key) return res.status(403).send('Forbidden');
  setSessionCookie(res, 'admin', 365);
  res.redirect('/dashboard');
});

// ── Config API ───────────────────────────────────────────────────────────────
app.get('/api/config', requireAuth, (req, res) => {
  res.json(getConfig(req.sessionKey));
});

app.put('/api/config', requireAuth, (req, res) => {
  const allowed = ['businessName','description','services','notifyEmail','faqs'];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
  res.json(saveConfig(req.sessionKey, updates));
});

app.delete('/api/leads/:id', requireAuth, (req, res) => {
  deleteLead(req.sessionKey, req.params.id);
  res.json({ ok: true });
});

// ── FAQ generator ────────────────────────────────────────────────────────────
app.post('/api/generate-faqs', requireAuth, async (req, res) => {
  const { businessName, description, services } = req.body;
  if (!businessName?.trim() && !description?.trim()) {
    return res.status(400).json({ error: 'Provide at least a business name or description.' });
  }
  let context = '';
  if (businessName) context += `Business name: ${businessName}\n`;
  if (description)  context += `Description: ${description}\n`;
  if (services)     context += `Services: ${services}\n`;

  try {
    const msg = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: 'You are a helpful assistant that generates FAQ content for small service businesses. Always respond with valid JSON only — no prose, no markdown fences.',
      messages: [{
        role: 'user',
        content: `Generate 5 to 7 frequently asked questions with concise, helpful answers for this business:\n\n${context}\nReturn a JSON array of objects with "question" and "answer" keys. Example format: [{"question":"...","answer":"..."}]`,
      }],
    });
    const text = msg.content[0].text.trim();
    const start = text.indexOf('[');
    const end   = text.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('No JSON array in response');
    const faqs = JSON.parse(text.slice(start, end + 1));
    res.json({ faqs });
  } catch (err) {
    console.error('FAQ generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate FAQs. Please try again.' });
  }
});

// ── Public agent info ────────────────────────────────────────────────────────
app.get('/api/agent/:agentId', (req, res) => {
  const config = getConfigByAgentId(req.params.agentId);
  if (!config) return res.status(404).json({ error: 'Not found' });
  res.json({ businessName: config.businessName });
});

// ── Chat (public, SSE) ───────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { agentId, message, history = [] } = req.body;
  if (!agentId || !message?.trim()) return res.status(400).json({ error: 'agentId and message required.' });

  const config = agentId === 'dev'
    ? { businessName: 'Dev Business', description: '', services: '', faqs: [], notifyEmail: '' }
    : getConfigByAgentId(agentId);
  if (!config) return res.status(404).json({ error: 'Agent not found.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: message.trim() },
  ];

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: [{ type: 'text', text: buildSystemPrompt(config), cache_control: { type: 'ephemeral' } }],
      messages,
    });

    let fullText = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullText += event.delta.text;
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    // Detect lead
    const LEAD_RE = /<<<LEAD:([^|>]+)\|([^>]+)>>>/;
    const m = fullText.match(LEAD_RE);
    let lead = null;
    if (m) {
      lead = {
        id:        Date.now().toString(36),
        name:      m[1].trim(),
        email:     m[2].trim(),
        message:   message.trim(),
        timestamp: new Date().toISOString(),
      };
      if (agentId !== 'dev') {
        saveLead(agentId, lead);
        await sendLeadEmail(config.notifyEmail, lead, config.businessName);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, lead: lead ? { name: lead.name, email: lead.email } : null })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Anthropic error:', err);
    res.write(`data: ${JSON.stringify({ error: err?.message || 'Something went wrong.' })}\n\n`);
    res.end();
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`\n  LeadDesk → http://localhost:${PORT}\n`));
