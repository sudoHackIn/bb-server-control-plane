export class InputQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: T) {
    if (this.ended) throw new Error("Qwen input is closed");
    this.values.push(value);
    this.wake?.();
  }
  close() {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) return;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
