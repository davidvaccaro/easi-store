export function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
export function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
export async function readJson(req, maxBytes = 16_384) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Send application/json.');
    let size = 0; const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw httpError(413, 'Request body is too large.');
        chunks.push(chunk);
    }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw httpError(400, 'Send a JSON object.'); }
}
