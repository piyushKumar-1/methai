// Backend WebSocket relay: the app connects here, the relay connects to the gateway's
// /v1/realtime with the API key. The key never reaches the app.
//   GRID_API_KEY=... npx tsx example/realtime-relay.ts
import WebSocket, { WebSocketServer } from 'ws';

const GATEWAY = process.env.GRID_REALTIME_URL ?? 'wss://grid.ai.juspay.net/v1/realtime';
const MODEL = process.env.GRID_REALTIME_MODEL ?? 'xor-latest-custom';
const PORT = Number(process.env.PORT ?? 8787);

const server = new WebSocketServer({ port: PORT });

server.on('connection', (client, req) => {
  // Authenticate your own app users here (session cookie / token in req.headers) before relaying.
  const upstream = new WebSocket(`${GATEWAY}?model=${encodeURIComponent(MODEL)}`, {
    headers: { Authorization: `Bearer ${process.env.GRID_API_KEY}` },
  });
  const pending: WebSocket.RawData[] = [];

  client.on('message', data => (upstream.readyState === WebSocket.OPEN ? upstream.send(data.toString()) : pending.push(data)));
  upstream.on('open', () => pending.splice(0).forEach(d => upstream.send(d.toString())));
  upstream.on('message', data => client.readyState === WebSocket.OPEN && client.send(data.toString()));

  const closeBoth = () => {
    client.close();
    upstream.close();
  };
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  upstream.on('error', err => {
    console.error('upstream error', err.message);
    closeBoth();
  });
});

console.log(`realtime relay on ws://0.0.0.0:${PORT} -> ${GATEWAY} (${MODEL})`);
