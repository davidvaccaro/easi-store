import { httpError } from '../http/utils.js';

const read = ['archive.read'];
const contribute = [...read, 'archive.import', 'datasets.write'];
const administer = [...contribute, 'archive.delete', 'connections.manage', 'transfers.manage', 'access.manage', 'identity.manage', 'activity.read'];
const roles = Object.freeze({ reader: Object.freeze(read), contributor: Object.freeze(contribute), administrator: Object.freeze(administer) });
const UID = '[0-9.]+';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const version = `versions/[1-9][0-9]{0,8}`;
const reading = [
    /^\/api\/v1\/(summary|capabilities|studies|dataset-tools\/download_dataset\.py)$/,
    new RegExp(`^/api/v1/studies/${UID}/series(?:/${UID}/instances)?$`),
    new RegExp(`^/api/v1/studies/${UID}/series/${UID}(?:/instances/${UID})?/thumbnail$`),
    new RegExp(`^/api/v1/studies/${UID}/export$`),
    new RegExp(`^/api/v1/download/${UID}/${UID}/${UID}$`),
    /^\/api\/v1\/datasets$/,
    new RegExp(`^/api/v1/datasets/${UUID}(?:/readiness|/${version}/manifest|/${version}/members/${UUID}/original)?$`)
];
export function permissionsFor(principal) { return [...(roles[principal?.role] || [])]; }
export function hasPermission(principal, permission) { return Boolean(roles[principal?.role]?.includes(permission)); }
export function requiredPermissions(method, pathname) {
    const get = ['GET', 'HEAD'].includes(method);
    if (pathname === '/api/v1/logout' && method === 'POST') return [];
    if (get && ['/api/v1/identity', '/api/v1/auth/activity', '/api/v1/auth/tokens'].includes(pathname)
        || method === 'POST' && ['/api/v1/auth/tokens', '/api/v1/auth/password'].includes(pathname)
        || method === 'DELETE' && new RegExp(`^/api/v1/auth/tokens/${UUID}$`).test(pathname)) return ['identity.manage'];
    if (pathname === '/api/v1/access-policy' && (get || method === 'PUT')) return ['access.manage'];
    if (pathname === '/api/v1/activity' && get) return ['activity.read'];
    if (pathname === '/api/v1/connections' && (get || method === 'POST')
        || new RegExp(`^/api/v1/connections/${UUID}$`).test(pathname) && ['PUT', 'DELETE'].includes(method)
        || new RegExp(`^/api/v1/connections/${UUID}/(test|search)$`).test(pathname) && method === 'POST') return ['connections.manage'];
    if (pathname === '/api/v1/jobs' && (get || method === 'POST')
        || new RegExp(`^/api/v1/jobs/${UUID}$`).test(pathname) && get
        || new RegExp(`^/api/v1/jobs/${UUID}/(cancel|retry)$`).test(pathname) && method === 'POST') return ['transfers.manage'];
    if (pathname === '/dicomweb' || pathname.startsWith('/dicomweb/')) {
        if (get || method === 'OPTIONS') return ['archive.read'];
        if (method === 'POST' && new RegExp(`^/dicomweb/studies(?:/${UID})?$`).test(pathname)) return ['archive.import'];
        return null;
    }
    if (get && reading.some(pattern => pattern.test(pathname))) return ['archive.read'];
    if (method === 'POST' && new RegExp(`^/api/v1/datasets/${UUID}/${version}/availability$`).test(pathname)) return ['archive.read'];
    if (method === 'POST' && ['/api/v1/instances', '/api/v1/demo'].includes(pathname)) return ['archive.import'];
    if (method === 'POST' && pathname === '/api/v1/datasets/demo') return ['archive.import', 'datasets.write'];
    if (method === 'POST' && pathname === '/api/v1/datasets' || method === 'PUT' && new RegExp(`^/api/v1/datasets/${UUID}$`).test(pathname)
        || method === 'POST' && new RegExp(`^/api/v1/datasets/${UUID}/versions$`).test(pathname)) return ['datasets.write'];
    if (method === 'DELETE' && (new RegExp(`^/api/v1/studies/${UID}$`).test(pathname) || new RegExp(`^/api/v1/datasets/${UUID}$`).test(pathname))
        || get && new RegExp(`^/api/v1/studies/${UID}/deletion-preview$`).test(pathname)) return ['archive.delete'];
    // New/unknown management operations must be deliberately classified before
    // a less-privileged identity can reach their implementation.
    return null;
}
export function authorize(principal, method, pathname) {
    const required = requiredPermissions(method, pathname);
    if (required === null ? !['GET', 'HEAD', 'OPTIONS'].includes(method) || principal?.role !== 'administrator' : required.some(permission => !hasPermission(principal, permission))) {
        throw httpError(403, 'Your account does not have permission for this operation.');
    }
}
export function publicIdentity(principal) {
    return principal ? { id: principal.id, displayName: principal.displayName, role: principal.role, source: principal.source } : null;
}
export function hasSuppliedCredential(req) {
    return req.headers.authorization !== undefined || /(?:^|;\s*)easi_store_session=/.test(req.headers.cookie || '');
}
