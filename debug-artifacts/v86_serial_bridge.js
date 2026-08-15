// Bridges v86's emulated COM1 (serial0) to a plain TCP server on the host,
// so an external tool (e.g. a real kernel debugger, or a test script) can
// attach and exchange raw bytes with the guest's serial port.
const { chromium } = require('playwright');
const net = require('net');
const fs = require('fs');

const LOG_PATH = '/private/tmp/claude-501/-Users-Apple-Documents-dev-v86--/af04c464-5f85-4c0f-b6ae-aefb4fbaf7b3/scratchpad/v86_serial_bridge.log';
fs.writeFileSync(LOG_PATH, '');
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
function logLine(line) {
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
    console.log(line);
}

const TCP_PORT = 7788;

(async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    page.on('pageerror', err => logLine(`[pageerror] ${err.message}`));

    // Expose a function the page can call to hand us each outgoing byte.
    let tcpSocket = null;
    const outgoingQueue = [];
    await page.exposeFunction('onSerialOutputByte', (byte) => {
        if (tcpSocket) {
            tcpSocket.write(Buffer.from([byte]));
        } else {
            outgoingQueue.push(byte);
            if (outgoingQueue.length > 100000) outgoingQueue.shift();
        }
    });

    await page.goto('http://localhost:8000/debug.html');
    await page.setInputFiles('#hda_image', '/Users/Apple/Documents/vms/tiny10/tiny10-windbg.img');
    await page.fill('#memory_size', '2047');
    await page.check('#acpi');
    await page.click('#start_emulation');
    await page.waitForSelector('#screen_container', { state: 'visible', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // Hook the bus: forward every outgoing byte to our exposed function,
    // and stash a way to inject incoming bytes from the TCP side. Inject
    // takes an array and loops *inside* the page context, so an entire
    // packet goes in with a single CDP round-trip instead of one await
    // per byte - important because per-byte round-trip latency could
    // easily exceed whatever inter-byte timeout the guest's UART/packet
    // reassembly logic expects.
    await page.evaluate(() => {
        window.__serialInjectBytes = (bytes) => {
            for (const byte of bytes) {
                window.emulator.bus.send('serial0-input', byte);
            }
        };
        window.emulator.bus.register('serial0-output-byte', (byte) => {
            window.onSerialOutputByte(byte);
        });
    });
    logLine('Bus hooks installed.');

    // Start the TCP server. Once a client connects, drain any queued bytes
    // and wire up bidirectional relay.
    const server = net.createServer((socket) => {
        logLine('TCP client connected.');
        tcpSocket = socket;
        while (outgoingQueue.length) {
            socket.write(Buffer.from([outgoingQueue.shift()]));
        }
        socket.on('data', async (data) => {
            await page.evaluate((bytes) => window.__serialInjectBytes(bytes), Array.from(data));
        });
        socket.on('close', () => {
            logLine('TCP client disconnected.');
            if (tcpSocket === socket) tcpSocket = null;
        });
        socket.on('error', (e) => logLine('TCP socket error: ' + e.message));
    });

    server.listen(TCP_PORT, '127.0.0.1', () => {
        logLine(`Serial bridge listening on 127.0.0.1:${TCP_PORT}`);
    });

    // Keep the browser (and thus the emulator) alive indefinitely; this
    // script is meant to be left running as long-lived infrastructure.
    await new Promise(() => {});
})();
