/**
 * A real Express app, wired the way server.js wires it.
 *
 * Nothing is stubbed: the actual auth middleware, permission guards, validation
 * schemas, controllers and models all run, against the real Postgres and Redis.
 * Only the pieces that server.js adds for deployment — static file serving, the
 * metrics endpoint, the share-domain block — are left out.
 */

import express from 'express';
import request from 'supertest';

import authRoutes from '../../../routes/auth.routes.js';
import fileRoutes from '../../../routes/file.routes.js';
import publicRoutes from '../../../routes/public.routes.js';
import shareRoutes from '../../../routes/share.routes.js';
import userRoutes from '../../../routes/user.routes.js';
import errorHandler from '../../../middleware/error.middleware.js';
import { csrfProtection } from '../../../middleware/csrf.middleware.js';
import { requestIdMiddleware } from '../../../middleware/requestId.middleware.js';

/** Build the API surface. */
function buildApi() {
  const app = express();
  app.set('trust proxy', 1);

  // Must be first: the auth middleware and audit logger both write to the
  // request context this establishes.
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', publicRoutes);
  app.use('/api', csrfProtection, authRoutes);
  app.use('/api/files', csrfProtection, fileRoutes);
  app.use('/api/user', csrfProtection, userRoutes);
  app.use('/s', shareRoutes);

  app.use(errorHandler);
  return app;
}

const api = buildApi();

/**
 * A supertest agent that keeps cookies between requests and always sends the
 * CSRF header, which is what a real browser client does.
 */
function client() {
  const agent = request.agent(api);
  const withCsrf =
    method =>
    (url, ...args) =>
      agent[method](url, ...args).set('X-Requested-With', 'XMLHttpRequest');

  return {
    agent,
    get: withCsrf('get'),
    post: withCsrf('post'),
    put: withCsrf('put'),
    delete: withCsrf('delete'),
  };
}

/**
 * Sign up a fresh account and return a logged-in client.
 * @returns {Promise<{client, user, email, password}>}
 */
async function signUpAndLogin({ email, password = 'correct-horse', name = 'Owner' } = {}) {
  const c = client();
  const address = email || `user-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}@example.com`;

  const signup = await c.post('/api/signup').send({ email: address, password, name });
  if (signup.status >= 400) {
    throw new Error(`signup failed (${signup.status}): ${JSON.stringify(signup.body)}`);
  }

  const login = await c.post('/api/login').send({ email: address, password });
  if (login.status >= 400) {
    throw new Error(`login failed (${login.status}): ${JSON.stringify(login.body)}`);
  }

  return { client: c, user: login.body.user, email: address, password };
}

/** Log in as an existing account and return a client holding its session. */
async function loginAs(email, password = 'correct-horse') {
  const c = client();
  const res = await c.post('/api/login').send({ email, password });
  return { client: c, response: res, user: res.body?.user };
}

/**
 * Get a logged-in owner account, whichever way is currently possible.
 *
 * Registering the first account switches self-service signup off — that is the
 * signup-control feature working as designed — so a test that needs a second
 * account has to seed it instead. This picks the right route automatically so
 * callers do not have to care how many accounts already exist.
 */
async function ensureOwner(options = {}) {
  const c = client();
  const status = await c.get('/api/signup-status');
  return status.body?.signupEnabled ? signUpAndLogin(options) : createAndLogin(options);
}

/**
 * Create an account by seeding the row, then log into it.
 *
 * Used when self-service signup is closed, which is how an additional account
 * comes to exist on a locked-down instance.
 */
async function createAndLogin(options = {}) {
  const { makeOwner } = await import('./factories.js');
  const owner = await makeOwner(options);
  const { client: c, response } = await loginAs(owner.email, owner.password);
  if (response.status >= 400) {
    throw new Error(`login failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return { client: c, user: response.body.user, email: owner.email, password: owner.password };
}

export { api, buildApi, client, signUpAndLogin, loginAs, createAndLogin, ensureOwner };
