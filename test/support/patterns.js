// Strings the leak scans look for, built at run time so this repository's own files never contain them.
const j = (...parts) => parts.join('');

export const HOME_MAC = j('/', 'Users', '/');
export const HOME_LINUX = j('/', 'home', '/');
export const SESSIONS = j('.testmuai', '/kaneai', '/sessions');
export const SHARE_PATH = j('/dashboard', '/share', '/');
export const TM_HOST = j('lambdatest', '.com');
export const FAKE_SHARE_HOST = j('tm', '.invalid');
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
