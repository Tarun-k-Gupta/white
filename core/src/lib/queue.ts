/** One writer queue per wallet: Storage uploads and registry txs never race on the nonce. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  pending = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const p = this.tail.then(fn);
    this.tail = p.then(
      () => this.pending--,
      () => this.pending--,
    );
    return p;
  }
}
