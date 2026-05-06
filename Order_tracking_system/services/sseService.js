// Real-time order status updates via Server-Sent Events (SSE)
// Maintains a Map of connected clients and broadcasts order status changes

const clients = new Map();
let _nextId = 1;

/**
 * Register a new SSE connection.
 * @param {Object} res - Express response object (the SSE stream)
 * @param {number} userId - User ID from session
 * @param {string} role - User role (ADMIN, DISPATCHER, OFFICE_EXECUTIVE, SALES_OFFICER, DEALER)
 * @returns {number} clientId assigned to this connection
 */
function addClient(res, userId, role) {
  const id = _nextId++;
  clients.set(id, { res, userId, role });
  return id;
}

/**
 * Remove a client from the registry (called on 'close' event).
 * @param {number} id - clientId to remove
 */
function removeClient(id) {
  clients.delete(id);
}

/**
 * Broadcast an order status change to all connected clients.
 * @param {Object} payload - { orderId, newStatus, updatedBy }
 */
function broadcastOrderUpdate(payload) {
  const data = JSON.stringify(payload);
  for (const [, client] of clients) {
    try {
      client.res.write(`event: order-status-changed\ndata: ${data}\n\n`);
    } catch {
      // Stale/closed socket — the 'close' handler will clean it up
    }
  }
}

// Heartbeat: send a comment line every 25s to keep connections alive
// through proxies and load balancers that close idle connections
setInterval(() => {
  for (const [, client] of clients) {
    try {
      client.res.write(': heartbeat\n\n');
    } catch {
      // Ignore errors — 'close' handler will remove stale sockets
    }
  }
}, 25_000);

module.exports = { addClient, removeClient, broadcastOrderUpdate };
