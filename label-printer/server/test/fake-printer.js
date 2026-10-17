// A simulated Link-OS printer that speaks Weblink the way a ZD411 does:
// main channel -> discovery packet; opens a raw channel on request; answers
// getvar; and treats any TEXT frame from the server as a protocol violation.

// rawProtocol: real ZD411 firmware opens the raw channel with the *main* subprotocol.
export function startFakePrinter(url, { serial = 'D4J123456789', dpi = '203', rawProtocol = 'v1.weblink.zebra.com' } = {}) {
  const received = [];
  const violations = [];
  const control = [];
  let rawSocket = null;
  let rawReadyResolve;
  const rawReady = new Promise((r) => (rawReadyResolve = r));

  const main = new WebSocket(url, ['v1.weblink.zebra.com']);
  main.binaryType = 'arraybuffer';
  main.onopen = () => {
    main.send(enc(JSON.stringify({ discovery_b64: 'OiwuBAIBAAFaQlIAAFgAAAA=' })));
  };
  main.onmessage = (ev) => {
    if (typeof ev.data === 'string') violations.push('text frame on main');
    const msg = JSON.parse(dec(ev.data));
    control.push(msg);
    if (msg.open === 'v1.raw.zebra.com' && !rawSocket) openRaw();
  };

  function openRaw() {
    rawSocket = new WebSocket(url, [rawProtocol]);
    rawSocket.binaryType = 'arraybuffer';
    rawSocket.onopen = () => {
      rawSocket.send(enc(JSON.stringify({ unique_id: serial, channel_name: 'v1.raw.zebra.com', channel_id: '2' })));
      rawReadyResolve();
    };
    rawSocket.onmessage = (ev) => {
      if (typeof ev.data === 'string') violations.push('text frame on raw');
      const text = dec(ev.data);
      if (text.startsWith('! U1 getvar "head.resolution.in_dpi"')) {
        rawSocket.send(enc(`"${dpi}"`));
        return;
      }
      received.push(text);
    };
  }

  return {
    main,
    received,
    violations,
    control,
    rawReady,
    alert(condition, state) {
      main.send(enc(JSON.stringify({
        alert: { unique_id: serial, type_id: 'ERROR', condition_id: condition, condition_state: state, condition },
      })));
    },
    close() {
      rawSocket?.close();
      main.close();
    },
  };
}

const enc = (s) => new TextEncoder().encode(s);
const dec = (d) => new TextDecoder().decode(d);
