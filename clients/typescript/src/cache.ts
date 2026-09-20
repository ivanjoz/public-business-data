/**
 * Persistent cache, IndexedDB when the runtime has it and memory when it does not (Node, SSR,
 * a private window that denies storage). Everything the client stores goes through here.
 *
 * Two kinds of entry, cached on different terms on purpose:
 *
 *   · the manifest — lives for `setCache(minutes)`, because it is the only thing that can tell
 *     us anything changed, and asking more often than that buys nothing.
 *   · a year payload — keyed by the hash the manifest gives it, so it is immutable: 2021.gz has
 *     not changed since it was published and never needs refetching. When a year does change,
 *     its hash changes, the key changes with it, and the old entry is swept on the next load.
 *
 * Putting a clock on the payloads instead would re-download a megabyte of history every 20
 * minutes to discover that none of it moved.
 */

const DB_NAME = 'public-business-data'
const DB_VERSION = 1
const STORE = 'files'

/** What a cache entry holds. `fetchedAt` is only read for the manifest. */
interface ICacheEntry {
	key: string
	bytes: Uint8Array
	fetchedAt: number
}

/** The subset of IndexedDB behaviour the client needs, so the memory fallback can stand in. */
export interface ICacheStore {
	get(key: string): Promise<ICacheEntry | undefined>
	put(key: string, bytes: Uint8Array): Promise<void>
	/** Deletes every key with this prefix except the ones listed — the hash sweep. */
	sweep(prefix: string, keep: Set<string>): Promise<void>
	clear(): Promise<void>
}

class MemoryStore implements ICacheStore {
	private readonly entries = new Map<string, ICacheEntry>()

	async get(key: string) {
		return this.entries.get(key)
	}

	async put(key: string, bytes: Uint8Array) {
		this.entries.set(key, { key, bytes, fetchedAt: Date.now() })
	}

	async sweep(prefix: string, keep: Set<string>) {
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix) && !keep.has(key)) this.entries.delete(key)
		}
	}

	async clear() {
		this.entries.clear()
	}
}

class IndexedDbStore implements ICacheStore {
	private database?: Promise<IDBDatabase>

	private open(): Promise<IDBDatabase> {
		this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, DB_VERSION)
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE)) {
					request.result.createObjectStore(STORE, { keyPath: 'key' })
				}
			}
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		})
		return this.database
	}

	private async transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const database = await this.open()
		return new Promise<T>((resolve, reject) => {
			const request = run(database.transaction(STORE, mode).objectStore(STORE))
			request.onsuccess = () => resolve(request.result)
			request.onerror = () => reject(request.error)
		})
	}

	async get(key: string) {
		return this.transaction<ICacheEntry | undefined>('readonly', (store) => store.get(key))
	}

	async put(key: string, bytes: Uint8Array) {
		await this.transaction('readwrite', (store) => store.put({ key, bytes, fetchedAt: Date.now() }))
	}

	async sweep(prefix: string, keep: Set<string>) {
		const keys = await this.transaction<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
		const stale = keys.filter((key) => typeof key === 'string' && key.startsWith(prefix) && !keep.has(key))

		const database = await this.open()
		const transaction = database.transaction(STORE, 'readwrite')
		for (const key of stale) transaction.objectStore(STORE).delete(key)
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve()
			transaction.onerror = () => reject(transaction.error)
		})
	}

	async clear() {
		await this.transaction('readwrite', (store) => store.clear())
	}
}

/**
 * The store for this runtime. IndexedDB is probed by opening it rather than by checking that
 * the global exists: Firefox in a private window exposes the API and then refuses to open,
 * and a client that cannot cache still has to work.
 */
export async function openCacheStore(): Promise<ICacheStore> {
	if (typeof indexedDB === 'undefined') return new MemoryStore()

	const store = new IndexedDbStore()
	try {
		await store.get('probe')
		return store
	} catch {
		return new MemoryStore()
	}
}

export type { ICacheEntry }
export { MemoryStore }
