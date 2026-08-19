export type BridgeEntry<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export class PromiseBridge<T> {
  private entries = new Map<string, BridgeEntry<T>>()

  create(id: string) {
    const existing = this.entries.get(id)
    if (existing) return existing.promise
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    this.entries.set(id, { promise, resolve, reject })
    return promise
  }

  resolve(id: string, value: T) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.resolve(value)
  }

  reject(id: string, error: Error) {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    entry.reject(error)
  }

  rejectAll(error: Error) {
    for (const entry of this.entries.values()) entry.reject(error)
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }
}
