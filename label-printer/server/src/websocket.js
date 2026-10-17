// Minimal RFC 6455 WebSocket server, written for Zebra Weblink.
//
// Why not a library: Weblink has quirks that are easier to honour when we
// own the handshake and framing:
//   * the 101 upgrade response MUST carry "Content-Length: 0"
//   * the printer only accepts BINARY frames (a text frame makes it close
//     the connection with code 1003)
//   * the printer pings ~every 60 s and drops the link after 3 missed pongs
// It also keeps the server dependency-free.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/**
 * Complete a WebSocket upgrade on a raw socket.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ protocols: string[] }} opts  subprotocols we are willing to speak
 * @returns {WsConnection|null}
 */
export function acceptUpgrade(req, socket, head, { protocols }) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  const version = req.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || !key || version !== '13') {
    rejectUpgrade(socket, 400, 'Bad WebSocket upgrade');
    return null;
  }

  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const protocol = offered.find((p) => protocols.includes(p));
  if (!protocol) {
    rejectUpgrade(socket, 400, 'Unsupported WebSocket subprotocol');
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      `Sec-WebSocket-Protocol: ${protocol}`,
      'Content-Length: 0', // required by Zebra Weblink
      '',
      '',
    ].join('\r\n'),
  );

  const conn = new WsConnection(socket, protocol, req);
  if (head && head.length) conn._onData(head);
  return conn;
}

export function rejectUpgrade(socket, status, message) {
  const body = message || '';
  socket.write(
    `HTTP/1.1 ${status} ${body}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

export class WsConnection extends EventEmitter {
  constructor(socket, protocol, req) {
    super();
    this.socket = socket;
    this.protocol = protocol;
    this.remote = req.headers['x-forwarded-for'] || socket.remoteAddress;
    this.open = true;
    this.lastSeen = Date.now();
    this._buf = Buffer.alloc(0);
    this._fragments = null; // { opcode, parts: Buffer[], size }

    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30_000);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed(1006));
    socket.on('error', (err) => {
      this.emit('error', err);
      this._closed(1006);
    });
  }

  /** Send a binary frame. Strings are UTF-8 encoded but still sent as binary. */
  send(data) {
    if (!this.open) throw new Error('WebSocket is closed');
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.socket.write(encodeFrame(OP.BINARY, payload));
  }

  sendJson(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    if (this.open) this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const r = Buffer.from(reason, 'utf8');
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(OP.CLOSE, payload));
      this.socket.end();
    } catch {
      /* socket already gone */
    }
    this._closed(code);
  }

  terminate() {
    this.socket.destroy();
    this._closed(1006);
  }

  _closed(code) {
    if (!this.open) return;
    this.open = false;
    this.emit('close', code);
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const big = this._buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.close(1009, 'Message too big');
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_MESSAGE_BYTES) return this.close(1009, 'Message too big');

      const maskLen = masked ? 4 : 0;
      if (this._buf.length < offset + maskLen + len) return; // wait for more

      let payload = this._buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this._buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload); // copy before unmasking
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = this._buf.subarray(offset + maskLen + len);

      this._handleFrame(fin, opcode, payload);
      if (!this.open) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP.PING:
        this.socket.write(encodeFrame(OP.PONG, payload));
        this.emit('ping');
        return;
      case OP.PONG:
        this.emit('pong');
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.emit('remote-close', code, reason);
        this.close(code === 1005 ? 1000 : code);
        return;
      }
      case OP.TEXT:
      case OP.BINARY:
        if (fin) {
          this.emit('message', payload, opcode === OP.BINARY);
        } else {
          this._fragments = { opcode, parts: [payload], size: payload.length };
        }
        return;
      case OP.CONT: {
        if (!this._fragments) return this.close(1002, 'Unexpected continuation');
        this._fragments.parts.push(payload);
        this._fragments.size += payload.length;
        if (this._fragments.size > MAX_MESSAGE_BYTES) return this.close(1009, 'Message too big');
        if (fin) {
          const { opcode: op, parts } = this._fragments;
          this._fragments = null;
          this.emit('message', Buffer.concat(parts), op === OP.BINARY);
        }
        return;
      }
      default:
        this.close(1002, 'Unknown opcode');
    }
  }
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]); // server frames are never masked
}
