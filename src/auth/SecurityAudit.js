import { publicIdentity } from './permissions.js';

/** Bounded local operational attribution, not a compliance audit/retention system. */
export class SecurityAudit {
    constructor(archive) {
        this.db = archive.db;
        this.db.exec(`CREATE TABLE IF NOT EXISTS security_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            actor TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL
        )`);
    }
    begin(principal, action) {
        const actor = publicIdentity(principal);
        const row = this.db.prepare('INSERT INTO security_activity(timestamp,actor,action,outcome) VALUES(?,?,?,?)')
            .run(new Date().toISOString(), actor ? JSON.stringify(actor) : null, action, 'started');
        this.db.prepare('DELETE FROM security_activity WHERE id <= ?').run(Number(row.lastInsertRowid) - 10000);
        return Number(row.lastInsertRowid);
    }
    finish(id, principal, outcome) {
        const actor = publicIdentity(principal);
        this.db.prepare('UPDATE security_activity SET actor=?,outcome=? WHERE id=?').run(actor ? JSON.stringify(actor) : null, outcome, id);
    }
    list() {
        return { items: this.db.prepare('SELECT id,timestamp,actor,action,outcome FROM security_activity ORDER BY id DESC LIMIT 100').all()
            .map(row => ({ ...row, actor: row.actor ? JSON.parse(row.actor) : null })) };
    }
}
export function auditAction(method, pathname) {
    // Categories omit query strings, medical UIDs, input bodies and credentials.
    if (pathname === '/api/v1/login') return 'identity.local-login';
    if (pathname === '/api/v1/setup') return 'identity.setup';
    if (pathname === '/api/v1/logout') return 'identity.logout';
    if (pathname === '/api/v1/auth/oidc/start') return 'identity.sso-start';
    if (pathname === '/api/v1/auth/oidc/callback') return 'identity.sso-callback';
    if (pathname.startsWith('/api/v1/auth/')) return `identity.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/access-policy')) return `access.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/health')) return `health.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/connections')) return `connections.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/jobs')) return `transfers.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/datasets')) return `datasets.${method.toLowerCase()}`;
    if (pathname.startsWith('/api/v1/download/')) return 'archive.download';
    if (pathname.startsWith('/api/v1/studies/') && pathname.endsWith('/export')) return 'archive.export';
    if (pathname.startsWith('/api/v1/studies/') && method === 'DELETE') return 'archive.delete';
    if (pathname === '/api/v1/instances' || pathname === '/api/v1/demo') return 'archive.import';
    if (pathname === '/dicomweb' || pathname.startsWith('/dicomweb/')) return `dicomweb.${method.toLowerCase()}`;
    return null;
}
