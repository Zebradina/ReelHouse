'use strict';

/**
 * LAN discovery for the ReelHouse TV app.
 *
 * The TV broadcasts a fixed probe string to UDP <port>, and this answers on the
 * HTTP port with a small JSON payload listing the machine's LAN addresses. A
 * unicast reply rather than mDNS means no extra dependency, no daemon and no
 * multicast group to join, and it survives routers that drop multicast.
 *
 * The client still checks each address with GET /api/status before using it, so
 * a stale address (or a different app holding the port) is rejected.
 */

const dgram = require('dgram');
const os = require('os');

const PROBE = 'REELHOUSE/1 DISCOVER';
const PROTOCOL = 1;
// Probes are tiny and fixed; anything longer is not ours.
const MAX_PROBE_BYTES = 64;

/** IPv4 addresses other devices on the network can reach. */
function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      // 169.254/16 is self-assigned: the machine could not get a DHCP lease.
      if (String(net.address).startsWith('169.254.')) continue;
      addresses.push(net.address);
    }
  }
  return addresses;
}

/**
 * Answer discovery probes on `port` (UDP), describing an HTTP server on the
 * same port. Returns null-ish handle when the port is already taken by another
 * copy of ReelHouse; the server itself keeps working either way.
 *
 * @param {{ port: number, version: string, name?: string, log?: Console }} options
 * @returns {{ close: () => void, port: number }}
 */
function start({ port, version, name = os.hostname(), log = console }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  socket.on('message', (msg, rinfo) => {
    if (msg.length > MAX_PROBE_BYTES) return;
    // Answer only the exact probe. Replying to arbitrary datagrams would turn
    // this into a reflector anyone on the network could aim elsewhere.
    if (msg.toString('utf8').trim() !== PROBE) return;

    const reply = JSON.stringify({
      app: 'ReelHouse',
      protocol: PROTOCOL,
      version,
      port,
      name,
      addresses: lanAddresses(),
    });
    socket.send(reply, rinfo.port, rinfo.address, () => {});
  });

  socket.on('error', (err) => {
    log.error(`[discovery] LAN discovery unavailable on UDP ${port}: ${err.message}`);
    close();
  });

  socket.bind(port);
  return { close, port };
}

module.exports = { start, lanAddresses, PROBE, PROTOCOL };
