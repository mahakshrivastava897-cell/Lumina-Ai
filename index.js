require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Groq = require('groq-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy on Render
app.set('trust proxy', 1);

// Basic Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Groq SDK Client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Configure Express Session
app.use(session({
  secret: process.env.SESSION_SECRET || 'lumina_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// Initialize Passport Auth
app.use(passport.initialize());
app.use(passport.session());

// Helper: Parse Student Academic Info from MITS Email Handle
function parseStudentProfile(email) {
  const handle = email.split('@')[0].toLowerCase();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const yearMatch = handle.match(/(\d{2})/);
  const branchMatch = handle.match(/([a-z]+)/);

  let admissionYear = currentYear;
  let branch = 'GENERAL';

  if (yearMatch) {
    admissionYear = 2000 + parseInt(yearMatch[1], 10);
  }
  if (branchMatch) {
    branch = branchMatch[1].toUpperCase();
  }

  const yearDiff = currentYear - admissionYear;
  let semester = yearDiff * 2 + (currentMonth >= 7 ? 1 : 0);
  if (semester < 1) semester = 1;
  if (semester > 8) semester = 8;

  return {
    branch,
    admissionYear,
    semester,
    academicYear: Math.ceil(semester / 2)
  };
}

// Passport Session Serializers
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Google OAuth Strategy Configuration
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    scope: ['profile', 'email'],
    proxy: true
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value || '';
    if (!email.endsWith('@mitsgwl.ac.in') && !email.endsWith('@mitsgwalior.in')) {
      return done(null, false, { message: 'Access restricted to official MITS email accounts.' });
    }
    const studentInfo = parseStudentProfile(email);
    const user = {
      id: profile.id,
      displayName: profile.displayName,
      email: email,
      ...studentInfo
    };
    return done(null, user);
  }
));

// OAuth Endpoints
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-failed' }),
  (req, res) => {
    res.redirect('/');
  }
);

app.get('/login-failed', (req, res) => {
  res.status(401).send('Access Denied: Please sign in using your official @mitsgwl.ac.in or @mitsgwalior.in email address.');
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ authenticated: true, user: req.user });
  } else {
    res.json({ authenticated: false });
  }
});

// Live Scraper for MITS Portal Notices
async function fetchMITSNotices() {
  try {
    const response = await axios.get('https://mitsgwalior.in/', { timeout: 5000 });
    const $ = cheerio.load(response.data);
    const notices = [];

    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (text && href && (href.endsWith('.pdf') || href.includes('notice') || href.includes('circular') || text.toLowerCase().includes('notice'))) {
        const fullLink = href.startsWith('http') ? href : `https://mitsgwalior.in/${href.replace(/^\//, '')}`;
        if (notices.length < 5 && !notices.some(n => n.link === fullLink)) {
          notices.push({ title: text, link: fullLink });
        }
      }
    });
    return notices;
  } catch (error) {
    console.error("Portal Scraper Error:", error.message);
    return [];
  }
}

// Protected Route Guard & Static Files
app.get('/', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/auth/google');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', { index: false }));

// Primary Chat Completion API Route
app.post('/api/chat', async (req, res) => {
  try {
    const { history, prompt } = req.body;
    let userPrompt = prompt || (Array.isArray(history) && history.length > 0 ? history[history.length - 1].text : "");

    let messages = [];

    // Construct System Instruction
    let systemMessage = `You are Lumina, the official AI assistant for MITS Gwalior (Madhav Institute of Technology & Science).`;
    if (req.isAuthenticated() && req.user) {
      systemMessage += ` Student Context: Name: ${req.user.displayName}, Email: ${req.user.email}, Branch: ${req.user.branch}, Semester: ${req.user.semester}.`;
    }

    // Live Scraper Check
    const lowerPrompt = userPrompt.toLowerCase();
    if (lowerPrompt.includes('link') || lowerPrompt.includes('notice') || lowerPrompt.includes('portal') || lowerPrompt.includes('recent')) {
      const liveNotices = await fetchMITSNotices();
      if (liveNotices.length > 0) {
        systemMessage += `\nLive active links from mitsgwalior.in:\n` + liveNotices.map(n => `- [${n.title}](${n.link})`).join('\n');
      }
    }

    messages.push({ role: 'system', content: systemMessage });

    if (Array.isArray(history) && history.length > 0) {
      const formattedHistory = history
        .filter(m => m.text && m.text !== "Sorry, something went wrong.")
        .map(m => ({
          role: m.sender === 'user' ? 'user' : 'assistant',
          content: m.text
        }));
      messages.push(...formattedHistory);
    } else if (userPrompt) {
      messages.push({ role: 'user', content: userPrompt });
    }

    // Groq API Call using supported active model
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: 'openai/gpt-oss-20b',
      temperature: 0.6,
      max_tokens: 1024,
    });

    const reply = completion.choices[0]?.message?.content || "No response generated.";
    res.json({ text: reply });

  } catch (error) {
    console.error("Groq Execution Error:", error);
    res.status(500).json({ 
      error: error.message || "Failed to process chat query." 
    });
  }
});

// Start Node Server
app.listen(PORT, () => {
  console.log(`Lumina AI Server listening on port ${PORT}`);
});