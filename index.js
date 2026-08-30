require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Groq = require('groq-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Initialize Free Groq AI Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'lumina_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// Scraping MITS Official Portal for Live Links and Documents
async function fetchMitsLiveNotices() {
  try {
    const { data } = await axios.get('https://mitsgwalior.in', { timeout: 4000 });
    const $ = cheerio.load(data);
    let resources = [];

    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (text && href && (href.includes('.pdf') || href.includes('notice') || href.includes('scheme') || href.includes('syllabus'))) {
        const fullUrl = href.startsWith('http') ? href : `https://mitsgwalior.in/${href.replace(/^\//, '')}`;
        resources.push(`- [${text}](${fullUrl})`);
      }
    });

    return resources.slice(0, 15).join('\n');
  } catch (err) {
    return "- Official Portal: [MITS Gwalior Website](https://mitsgwalior.in)";
  }
}

// Academic Metadata Parser
function parseStudentProfile(email) {
  const handle = email.split('@')[0].toLowerCase();
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const match = handle.match(/^(\d{2})([a-z]+)/);

  let admissionYear = currentYear;
  let branch = 'GENERAL';

  if (match) {
    admissionYear = 2000 + parseInt(match[1], 10);
    branch = match[2].toUpperCase();
  }

  const yearDiff = currentYear - admissionYear;
  let semester = yearDiff * 2 + (currentMonth >= 7 ? 1 : 0);
  if (semester < 1) semester = 1;
  if (semester > 8) semester = 8;

  const academicYear = Math.ceil(semester / 2);

  return { branch, admissionYear, semester, academicYear };
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "/auth/google/callback",
    scope: ['profile', 'email'],
    proxy: true
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : '';
    const isMitsEmail = email.endsWith('@mitsgwl.ac.in') || email.endsWith('@mitsgwalior.in');

    if (!isMitsEmail) {
      return done(null, false, { message: 'Access restricted to official MITS email accounts.' });
    }

    const academicInfo = parseStudentProfile(email);

    const userProfile = {
      id: profile.id,
      displayName: profile.displayName,
      email: email,
      photo: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
      ...academicInfo
    };

    return done(null, userProfile);
  }
));

// Authentication Routes
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-failed' }),
  (req, res) => res.redirect('/')
);

// Protected Root Route
app.get('/', (req, res) => {
  if (!req.isAuthenticated()) {
    return res.redirect('/auth/google');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public', { index: false }));

app.get('/api/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ authenticated: true, user: req.user });
  } else {
    res.json({ authenticated: false });
  }
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.redirect('/auth/google');
  });
});

app.get('/login-failed', (req, res) => {
  res.status(403).send('Access Denied: You must sign in with an official MITS college account (@mitsgwl.ac.in or @mitsgwalior.in).');
});

// High-Speed, Zero-Quota Error Chat Endpoint (Groq + Cheerio Scraper)
app.post('/api/chat', async (req, res) => {
  try {
    const body = req.body || {};
    let messages = [];

    if (Array.isArray(body.history) && body.history.length > 0) {
      let historyList = [...body.history];
      if (historyList.length > 0 && historyList[0].sender === 'bot') {
        historyList.shift();
      }

      messages = historyList.map(msg => ({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text
      }));
    }

    if (messages.length === 0) {
      let userPrompt = body.prompt || body.message || body.contents || body.text || body.query;
      if (userPrompt && typeof userPrompt === 'string' && userPrompt.trim()) {
        messages = [{ role: 'user', content: userPrompt.trim() }];
      }
    }

    if (messages.length === 0) {
      return res.status(400).json({ error: "Message content cannot be empty." });
    }

    const currentDateStr = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Fetch live links directly from mitsgwalior.in
    const livePortalData = await fetchMitsLiveNotices();

    let systemInstruction = `Today's date is strictly ${currentDateStr}. You are Lumina, the official AI chatbot for MITS Gwalior (Madhav Institute of Technology & Science).
Available Live MITS Documents & Links:\n${livePortalData}`;

    if (req.isAuthenticated() && req.user) {
      systemInstruction += `\n\nActive Student Details:
- Name: ${req.user.displayName}
- Email: ${req.user.email}
- Course: B.Tech
- Branch: ${req.user.branch}
- Semester: Semester ${req.user.semester}
- Academic Year: Year ${req.user.academicYear} (Admitted ${req.user.admissionYear})

Guidelines:
1. Automatically acknowledge their branch (${req.user.branch}) and semester (${req.user.semester}) whenever appropriate.
2. Provide direct markdown links to official MITS resources listed above.
3. Keep responses fast, concise, and formatted with markdown.`;
    }

    // Prepend system instruction to messages list
    messages.unshift({ role: 'system', content: systemInstruction });

    // Call Groq API (Llama 3.3 70B Model)
    // Call Groq API
    const completion = await groq.chat.completions.create({
      messages: messages,
      model: 'llama-3.1-8b-instant', // <--- UPDATE THIS LINE
      temperature: 0.6,
      max_tokens: 1024,
    });

    res.json({ text: completion.choices[0]?.message?.content || "No response generated." });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Lumina-Ai chatbot server running on port ${port}`);
});