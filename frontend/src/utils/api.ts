/**
 * API layer barrel. The implementation is split by domain under `./api/`
 * (client, config, users, files, sessions, mfa, versions, clients, orphans,
 * auth); this file re-exports it all so existing `from '../utils/api'` imports
 * keep working. New code may import the specific module directly if preferred.
 */
export * from './api/client';
export * from './api/config';
export * from './api/users';
export * from './api/files';
export * from './api/sessions';
export * from './api/mfa';
export * from './api/versions';
export * from './api/clients';
export * from './api/orphans';
export * from './api/auth';
