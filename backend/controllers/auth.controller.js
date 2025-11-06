const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId
} = require('../models/user.model');
const { getCookieOptions, isValidEmail, isValidPassword, generateAuthToken } = require('../utils/auth');
const { sendError, sendSuccess } = require('../utils/response');

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const GOOGLE_AUTH_ENABLED =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI;
let googleClient;
if (GOOGLE_AUTH_ENABLED) {
  googleClient = new OAuth2Client(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
} else {
  console.log('Google OAuth disabled');
}

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!GOOGLE_AUTH_ENABLED) {
  console.warn(
    'Google OAuth credentials missing. Google login endpoints will be disabled.'
  );
}

async function signup(req, res) {
  try {
    const { email, password, name } = req.body;
    
    // Input validation
    if (!email || !password) {
      return sendError(res, 400, 'Email and password required');
    }
    
    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format');
    }
    
    if (!isValidPassword(password)) {
      return sendError(res, 400, 'Password must be at least 6 characters');
    }
    
    // Name validation (if provided)
    if (name && (typeof name !== 'string' || name.trim().length === 0)) {
      return sendError(res, 400, 'Invalid name');
    }
    
    const existing = await getUserByEmail(email);
    if (existing) {
      return sendError(res, 409, 'Email already in use');
    }
    
    const hashed = await bcrypt.hash(password, 10);
    const user = await createUser(email, hashed, name);
    const token = generateAuthToken(user.id, JWT_SECRET);
    res.cookie('token', token, getCookieOptions());
    sendSuccess(res, { user });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return sendError(res, 400, 'Email and password required');
    }
    
    if (!isValidEmail(email)) {
      return sendError(res, 400, 'Invalid email format');
    }
    
    const user = await getUserByEmail(email);
    if (!user) {
      return sendError(res, 401, 'Invalid credentials');
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return sendError(res, 401, 'Invalid credentials');
    }

    const token = generateAuthToken(user.id, JWT_SECRET);
    res.cookie('token', token, getCookieOptions());
    sendSuccess(res, { user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

function googleLogin(req, res) {
  if (!GOOGLE_AUTH_ENABLED) {
    return res.status(503).send('Google OAuth disabled');
  }
  const url = googleClient.generateAuthUrl({
    scope: ['profile', 'email'],
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect(url);
}

async function googleCallback(req, res) {
  try {
    if (!GOOGLE_AUTH_ENABLED) {
      return res.status(503).send('Google OAuth disabled');
    }
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const { tokens } = await googleClient.getToken(code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name;

    let user = await getUserByGoogleId(googleId);
    if (!user) {
      user = await getUserByEmail(email);
      if (user) {
        await updateGoogleId(user.id, googleId);
      } else {
        user = await createUserWithGoogle(googleId, email, name);
      }
    }

    const token = generateAuthToken(user.id, JWT_SECRET);
    res.cookie('token', token, getCookieOptions());
    res.redirect(CLIENT_URL);
  } catch (err) {
    console.error(err);
    res.status(500).send('Authentication failed');
  }
}

function logout(req, res) {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
}

async function profile(req, res) {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'Not found');
    }
    sendSuccess(res, user);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  signup,
  login,
  googleLogin,
  googleCallback,
  logout,
  profile,
  googleAuthEnabled: !!GOOGLE_AUTH_ENABLED
};
