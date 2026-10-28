import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Isolated local-browser QA; never attach to the user's personal browser profile. */
export async function browserSession(output, extraArguments = []) {
    await mkdir(output, { recursive: true });
    const profile = await mkdtemp(join(output, 'profile-'));
    const executable = process.env.EASI_VIEW_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const processHandle = spawn(executable, [
        '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...extraArguments, 'about:blank'
    ], { stdio: 'ignore' });
    let processError;
    processHandle.on('error', error => { processError = error; });
    let socket;
    const pending = new Map();
    const errors = [];
    const requests = [];
    const consoleErrors = [];
    const eventListeners = new Set();
    let sequence = 0;
    const close = () => {
        for (const item of pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Browser QA closed.')); }
        pending.clear();
        socket?.close();
        processHandle.kill('SIGTERM');
    };
    try {
        let port;
        for (let index = 0; index < 100; index++) {
            if (processError) throw processError;
            if (processHandle.exitCode != null || processHandle.signalCode != null) throw new Error('QA browser exited before connecting.');
            try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
            catch { await delay(100); }
        }
        if (!port) throw new Error('QA browser did not start. Set EASI_VIEW_BROWSER to your Chrome executable.');
        const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        });
        const send = (method, params = {}) => new Promise((resolve, reject) => {
            const id = ++sequence;
            const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, 15000);
            pending.set(id, { resolve, reject, timeout });
            socket.send(JSON.stringify({ id, method, params }));
        });
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const item = pending.get(message.id);
            if (item) {
                clearTimeout(item.timeout); pending.delete(message.id);
                message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
            } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            else if (message.method === 'Network.requestWillBeSent') requests.push({ url: message.params.request.url, method: message.params.request.method });
            else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(message.params.args.map(item => item.value ?? item.description).join(' '));
            if (message.method) for (const listener of eventListeners) listener(message.method, message.params);
        });
        const evaluate = async expression => {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
            return result.result?.value;
        };
        const until = async (expression, message, attempts = 120) => {
            for (let index = 0; index < attempts; index++) {
                const value = await evaluate(expression);
                if (value) return value;
                if (errors.length) throw new Error(JSON.stringify(errors));
                await delay(100);
            }
            throw new Error(message);
        };
        const screenshot = async name => {
            await evaluate('(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()');
            const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
            await writeFile(join(output, `${name}.png`), Buffer.from(result.data, 'base64'));
        };
        await send('Runtime.enable');
        await send('Page.enable');
        await send('Network.enable');
        // Observe CDP network events without replacing browser-native transports.
        // Callers must redact credentials before retaining any event details.
        const onEvent = listener => { eventListeners.add(listener); return () => eventListeners.delete(listener); };
        return { send, evaluate, until, screenshot, errors, requests, consoleErrors, onEvent, close };
    } catch (error) { close(); throw error; }
}
