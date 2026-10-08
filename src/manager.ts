import { Client, CalciteError, type ClientOptions, type ClientStatus } from './client.js';

/** Owns several named clients in one process; stops them all on shutdown. */
export class ClientManager {
  private readonly clients = new Map<string, Client>();
  private exitHooked = false;

  get(name: string): Client {
    const client = this.clients.get(name);
    if (!client) {
      const known = [...this.clients.keys()];
      throw new CalciteError('unknown_client', `No client named "${name}"${known.length ? ` (running: ${known.join(', ')})` : ''}`);
    }
    return client;
  }

  /** The only client when exactly one exists, otherwise the named one. */
  resolve(name?: string): Client {
    if (name) return this.get(name);
    if (this.clients.size === 1) return [...this.clients.values()][0];
    if (this.clients.size === 0) throw new CalciteError('no_clients', 'No client is running; launch one first');
    throw new CalciteError('ambiguous_client', `Several clients are running (${[...this.clients.keys()].join(', ')}); pass a name`);
  }

  list(): ClientStatus[] {
    return [...this.clients.values()].map((c) => c.status());
  }

  /** Creates and starts a client. A stopped/crashed client with the same name is replaced. */
  async launch(options: ClientOptions): Promise<Client> {
    const existing = this.clients.get(options.name);
    if (existing && !['stopped', 'crashed', 'idle'].includes(existing.phase)) {
      throw new CalciteError('already_running', `Client "${options.name}" is already ${existing.phase}`);
    }
    this.hookExit();
    const client = new Client(options);
    this.clients.set(options.name, client);
    try {
      await client.start();
    } catch (err) {
      this.clients.delete(options.name);
      throw err;
    }
    return client;
  }

  async stop(name: string): Promise<void> {
    const client = this.get(name);
    await client.stop();
    this.clients.delete(name);
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }

  private hookExit(): void {
    if (this.exitHooked) return;
    this.exitHooked = true;
    const shutdown = (signal: NodeJS.Signals) => {
      void this.stopAll().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
}
