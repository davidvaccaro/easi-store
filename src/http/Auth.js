import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, open, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
const scrypt = promisify(derive);
const digest = value => createHash('sha256').update(value).digest('hex');
export const isLoopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const unauthorized = message => Object.assign(new Error(message), { statusCode: 401 });
async function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const file = await open(directory, 'r');
    try { await file.sync(); } finally { await file.close(); }
}

export class Auth {
    constructor(dataDir) {
        this.path = path.join(dataDir, 'auth.json'); this.dataDir = dataDir;
        this.record = null; this.sessions = new Map(); this.attempts = new Map();
    }
    async open() {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        try { this.record = JSON.parse(await readFile(this.path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const bootstrapPath = path.join(this.dataDir, 'bootstrap-token');
        try { this.bootstrap = (await readFile(bootstrapPath, 'utf8')).trim(); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.bootstrap = randomBytes(32).toString('base64url');
            const file = await open(bootstrapPath, 'wx', 0o600);
            try { await file.writeFile(this.bootstrap + '\n'); await file.sync(); } finally { await file.close(); }
            await syncDirectory(this.dataDir);
        }
        return this;
    }
    async save() {
        const temp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
        const file = await open(temp, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(this.record) + '\n'); await file.sync(); } finally { await file.close(); }
        await rename(temp, this.path);
        await syncDirectory(this.dataDir);
    }
    rateLimit(address) {
        const now = Date.now();
        for (const [key, value] of this.attempts) if (value.reset < now) this.attempts.delete(key);
        if (!this.attempts.has(address)) {
            if (this.attempts.size >= 500) throw Object.assign(new Error('Too many authentication attempts. Try again later.'), { statusCode: 429 });
            this.attempts.set(address, { count: 0, reset: now + 15 * 60_000 });
        }
        if (++this.attempts.get(address).count > 10) throw Object.assign(new Error('Too many authentication attempts. Try again later.'), { statusCode: 429 });
    }
    async setup({ username, password, bootstrapToken }, address) {
        if (this.record) throw Object.assign(new Error('An administrator is already configured.'), { statusCode: 409 });
        this.rateLimit(address);
        if (!isLoopback(address) && (typeof bootstrapToken !== 'string' || digest(bootstrapToken) !== digest(this.bootstrap))) {
            throw unauthorized('Enter the one-time bootstrap token from the server data directory.');
        }
        if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{3,80}$/.test(username)) throw Object.assign(new Error('Username must contain 3–80 letters, numbers, or . _ @ -.'), { statusCode: 400 });
        if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Object.assign(new Error('Use a password with 12–1024 characters.'), { statusCode: 400 });
        // Reserve setup before yielding to password derivation; concurrent requests cannot replace the first administrator.
        if (this.settingUp) throw Object.assign(new Error('Administrator setup is already in progress.'), { statusCode: 409 });
        this.settingUp = true;
        try {
            const salt = randomBytes(16).toString('hex');
            const hash = Buffer.from(await scrypt(password, salt, 64)).toString('hex');
            const previous = this.record;
            this.record = { version: 1, username, salt, hash, apiTokens: [] };
            try { await this.save(); } catch (error) { this.record = previous; throw error; }
        } finally { this.settingUp = false; }
        return this.session();
    }
    async login({ username, password }, address) {
        this.rateLimit(address);
        const record = this.record;
        if (!record || typeof password !== 'string' || password.length > 1024) throw unauthorized('Invalid username or password.');
        const actual = Buffer.from(await scrypt(password, record.salt, 64));
        if (username !== record.username || !timingSafeEqual(actual, Buffer.from(record.hash, 'hex'))) throw unauthorized('Invalid username or password.');
        this.attempts.delete(address);
        return this.session();
    }
    session() {
        const token = randomBytes(32).toString('base64url'), now = Date.now();
        for (const [key, expires] of this.sessions) if (expires < now) this.sessions.delete(key);
        if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
        this.sessions.set(digest(token), now + 12 * 60 * 60_000);
        return token;
    }
    identify(req) {
        const authorization = req.headers.authorization;
        if (authorization) {
            if (!authorization.startsWith('Bearer ') || authorization.length > 512) return null;
            const hash = digest(authorization.slice(7));
            return this.record?.apiTokens?.some(token => token.hash === hash) ? 'bearer' : null;
        }
        const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('easi_store_session='));
        if (!cookie || cookie.length > 512) return null;
        const expires = this.sessions.get(digest(cookie.slice('easi_store_session='.length)));
        return expires && expires > Date.now() ? 'session' : null;
    }
    logout(req) {
        const cookie = (req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('easi_store_session='));
        if (cookie) this.sessions.delete(digest(cookie.slice('easi_store_session='.length)));
    }
    async issueApiToken(label = 'Local integration') {
        if (!this.record) throw new Error('Create an administrator in the browser before creating an API token.');
        const token = randomBytes(32).toString('base64url');
        this.record.apiTokens.push({ hash: digest(token), label: String(label).slice(0, 120), createdAt: new Date().toISOString() });
        await this.save(); return token;
    }
}
