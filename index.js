require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { GoogleGenAI } = require('@google/genai');

const app = express();
const port = process.env.PORT || 3000;

// Enable trust proxy for Render reverse proxy HTTPS redirect handling
app.set('trust proxy', 1);

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Middleware Setup
app.use(express.json());
app.use(express.static('public'));
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

// Student Profile Parser Function
function parseStudentProfile(email) {
  const handle = email.split('@')[0].toLowerCase();
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // August = 8

  // Matches 2-digit year followed by branch code (e.g. '25' and 'ai' in '25ai1ma80')
  const match = handle.match(/^(\d{2})([a-z]+)/);

  let admissionYear = currentYear;
  let branch = 'GENERAL';

  if (match) {
    admissionYear = 2000 + parseInt(match[1], 10); // '25' -> 2025
    branch = match[2].toUpperCase();             // 'ai' -> 'AI'
  }

  // Active Semester & Academic Year Calculation
  const yearDiff = currentYear - admissionYear;
  let semester = yearDiff * 2 + (currentMonth >= 7 ? 1 : 0);
  if (semester < 1) semester = 1;
  if (semester > 8) semester = 8;

  const academicYear = Math.ceil(semester / 2);

  return { branch, admissionYear, semester, academicYear };
}

// Passport Serialization
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Passport Google OAuth Strategy
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
    res.redirect('/');
  });
});

app.get('/login-failed', (req, res) => {
  res.status(403).send('Access Denied: You must sign in with an official MITS account.');
});

// Gemini AI Chat Endpoint
app.post('/api/chat', async (req, res) => {
  try {
    // Accepts prompt, message, or contents from frontend payloads
    const userPrompt = req.body.prompt || req.body.message || req.body.contents;

    if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
      return res.status(400).json({ error: "Message content cannot be empty." });
    }

    // Personalize prompt instructions using authenticated student session data
    let systemInstruction = "You are Lumina, an intelligent assistant for MITS Gwalior students. Keep answers concise, helpful, and natural.";
    
    if (req.isAuthenticated() && req.user) {
      systemInstruction += ` You are currently assisting ${req.user.displayName}, a student in the ${req.user.branch} branch (Semester ${req.user.semester}, Academic Year ${req.user.academicYear}).`;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: userPrompt,
      config: {
        systemInstruction: systemInstruction
      }
    });

    res.json({ text: response.text });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Lumina-Ai server running on port ${port}`);
});