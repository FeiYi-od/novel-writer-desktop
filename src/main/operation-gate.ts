/** Concurrent ordinary operations, exclusive directory swaps, in arrival order. */
export class OperationGate {
  private active = 0;
  private writing = false;
  private writers = 0;
  private queue: { exclusive: boolean; start: () => void }[] = [];
  get exclusivePending() { return this.writers > 0; }
  shared<T>(action: () => T | Promise<T>): Promise<T> { return this.enter(false, action); }
  exclusive<T>(action: () => T | Promise<T>): Promise<T> { return this.enter(true, action); }
  private enter<T>(exclusive: boolean, action: () => T | Promise<T>): Promise<T> {
    if (exclusive) this.writers++;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ exclusive, start: () => {
        this.active++;
        if (exclusive) this.writing = true;
        const release = () => {
          this.active--;
          if (exclusive) { this.writing = false; this.writers--; }
          this.pump();
        };
        void Promise.resolve().then(action).then(value => { release(); resolve(value); }, error => { release(); reject(error); });
      } });
      this.pump();
    });
  }
  private pump() {
    if (this.writing) return;
    while (this.queue.length) {
      const next = this.queue[0];
      if (next.exclusive && this.active) return;
      this.queue.shift(); next.start();
      if (next.exclusive) return;
    }
  }
}
