/** HTTP client for the robot adapter (robot/blackbox_robot/adapter.py). */
export class RobotClient {
  constructor(public base: string) {}

  private async call(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<any> {
    const res = await fetch(this.base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j: any = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!res.ok || j.ok === false) throw new Error(`robot ${path}: ${j.error ?? res.status}`);
    return j;
  }

  health = () => this.call("GET", "/health", undefined, 3000);
  state = (since = 0) => this.call("GET", `/state?since=${since}`, undefined, 3000);
  prepare = (b: unknown) => this.call("POST", "/mission/prepare", b, 60000);
  go = () => this.call("POST", "/mission/go", {});
  place = (b: unknown) => this.call("POST", "/world/place", b);
  decision = (bundle: unknown, source: string) => this.call("POST", "/decision", { bundle, source });
  human = (b: unknown) => this.call("POST", "/human", b);
  estop = () => this.call("POST", "/estop", {});
  sign = (b: unknown) => this.call("POST", "/sign", b);
  counterfactual = (force = "continue") => this.call("POST", "/counterfactual", { force }, 60000);
  replay = (entries?: unknown[]) => this.call("POST", "/replay", entries ? { entries } : {}, 120000);

  async bytes(path: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(this.base + path, { signal: AbortSignal.timeout(3000) });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
}
