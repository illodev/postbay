import http from 'node:http';

export interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

type Responder = (req: Received, n: number) => { status: number; headers?: Record<string, string>; body?: string } | 'hang';

/** A webhook receiver for tests: remembers every request and answers as told. */
export class Receiver {
  server!: http.Server;
  url = '';
  requests: Received[] = [];
  responder: Responder = () => ({ status: 200 });
  private hanging: http.ServerResponse[] = [];

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        const got: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, json };
        this.requests.push(got);
        const out = this.responder(got, this.requests.length);
        if (out === 'hang') {
          this.hanging.push(res);
          return;
        }
        res.writeHead(out.status, out.headers ?? {});
        res.end(out.body ?? '');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/hook`;
    return this;
  }

  reset() {
    this.requests.length = 0;
    this.responder = () => ({ status: 200 });
  }

  async stop() {
    for (const r of this.hanging) r.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
