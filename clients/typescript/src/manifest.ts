/**
 * The manifest is the entry point: it says which years exist and carries the hash that decides
 * whether a cached year is still current. Everything else the client does starts from here.
 */

import { openCacheStore, type ICacheStore } from './cache'

/** One published year. The path is not stored — it is `${datasetKey}/${year}.gz`. */
export interface IManifestFile {
	/** FNV-1a 64 of the uncompressed payload. The cache key, and the lambda's change detector. */
	hash: string
	records: number
	lastDate: string
}

export interface IManifestDataset {
	title: string
	source: string
	sourceUrl: string
	unit: string
	record: string
	scale: number
	hashAlgo: string
	files: Record<string, IManifestFile>
}

export interface IManifest {
	version: number
	/** Unix seconds of the last publish. */
	generated: number
	datasets: Record<string, IManifestDataset>
}

/** Where a year of a dataset lives, derived the same way the Go side derives it. */
export function filePath(datasetKey: string, year: string): string {
	return `${datasetKey}/${year}.gz`
}

export interface IClientOptions {
	/** Defaults to the published site. Point it at a local docs/ to develop against a copy. */
	baseUrl?: string
	/** Minutes before the manifest is re-checked. See setCache(). */
	cacheMinutes?: number
	fetch?: typeof globalThis.fetch
	/** Overrides the IndexedDB store. Mostly for tests. */
	cache?: ICacheStore
}

export const DEFAULT_BASE_URL = 'https://public-business-data.un.pe'

/** Twenty minutes: SUNAT publishes once a day, so checking three times an hour is already generous. */
export const DEFAULT_CACHE_MINUTES = 20

const textDecoder = new TextDecoder()
const textEncoder = new TextEncoder()

/**
 * Fetches and holds the manifest, and owns the cache every dataset reads through. Separate from
 * the datasets because each one added later shares the same manifest and the same store.
 */
export class ManifestStore {
	readonly baseUrl: string
	private ttlMs: number
	private readonly fetchImpl: typeof globalThis.fetch
	private readonly cacheOverride?: ICacheStore

	private store?: Promise<ICacheStore>
	private cached?: IManifest
	private cachedAt = 0
	private inFlight?: Promise<IManifest>
	private forceNetwork = false

	constructor(options: IClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
		this.ttlMs = (options.cacheMinutes ?? DEFAULT_CACHE_MINUTES) * 60_000
		this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args))
		this.cacheOverride = options.cache
	}

	/** How long the manifest is trusted before being re-checked. 0 or less disables the reuse. */
	setCacheMinutes(minutes: number): void {
		this.ttlMs = minutes * 60_000
		// A shorter window has to apply now, not after the current one would have expired.
		if (Date.now() - this.cachedAt >= this.ttlMs) this.invalidate()
	}

	cacheMinutes(): number {
		return this.ttlMs / 60_000
	}

	cache(): Promise<ICacheStore> {
		this.store ??= this.cacheOverride ? Promise.resolve(this.cacheOverride) : openCacheStore()
		return this.store
	}

	url(path: string): string {
		return `${this.baseUrl}/${path}`
	}

	/** Cache key of a dataset year. The hash in it is what makes the entry immutable. */
	fileKey(path: string, hash: string): string {
		return `file:${this.baseUrl}:${path}:${hash}`
	}

	filePrefix(): string {
		return `file:${this.baseUrl}:`
	}

	/** The manifest: memory, then IndexedDB, then the network. Concurrent callers share one request. */
	async get(): Promise<IManifest> {
		if (this.cached && Date.now() - this.cachedAt < this.ttlMs) return this.cached
		if (this.inFlight) return this.inFlight

		this.inFlight = this.load().finally(() => {
			this.inFlight = undefined
		})
		return this.inFlight
	}

	/**
	 * Makes the next read go to the network. It has to skip the persistent entry too, not just
	 * the in-memory one: the stored copy is still inside its window, so dropping only the
	 * memory copy would "refresh" straight back into IndexedDB and never leave the machine.
	 */
	invalidate(): void {
		this.cached = undefined
		this.cachedAt = 0
		this.forceNetwork = true
	}

	/** Empties the persistent cache — every manifest and every year of every origin. */
	async clearCache(): Promise<void> {
		this.invalidate()
		await (await this.cache()).clear()
	}

	async fetchBytes(path: string): Promise<Uint8Array> {
		const response = await this.fetchImpl(this.url(path))
		if (!response.ok) throw new Error(`GET ${path} respondió ${response.status}`)
		return new Uint8Array(await response.arrayBuffer())
	}

	private async load(): Promise<IManifest> {
		const store = await this.cache()
		const key = `manifest:${this.baseUrl}`

		const stored = await store.get(key).catch(() => undefined)
		const storedIsFresh = !this.forceNetwork && stored && Date.now() - stored.fetchedAt < this.ttlMs
		// Consumed here and not after the request: a failed refresh should not keep forcing the
		// network on every later call.
		this.forceNetwork = false

		if (storedIsFresh) {
			return this.adopt(JSON.parse(textDecoder.decode(stored.bytes)) as IManifest, stored.fetchedAt)
		}

		let fetched: IManifest
		try {
			const response = await this.fetchImpl(this.url('manifest.json'))
			if (!response.ok) throw new Error(`GET manifest.json respondió ${response.status}`)
			const text = await response.text()
			fetched = JSON.parse(text) as IManifest
			await store.put(key, textEncoder.encode(text)).catch(() => undefined)
		} catch (error) {
			// Stale beats nothing: the data is a historical series, so an expired manifest still
			// answers every question except "what happened today".
			if (stored) return this.adopt(JSON.parse(textDecoder.decode(stored.bytes)) as IManifest, stored.fetchedAt)
			throw error
		}

		void this.sweep(fetched, store)
		return this.adopt(fetched, Date.now())
	}

	private adopt(manifest: IManifest, fetchedAt: number): IManifest {
		this.cached = manifest
		this.cachedAt = fetchedAt
		return manifest
	}

	/** Drops cached years whose hash the manifest no longer names. Fire and forget. */
	private async sweep(manifest: IManifest, store: ICacheStore): Promise<void> {
		const keep = new Set<string>()
		for (const [datasetKey, dataset] of Object.entries(manifest.datasets ?? {})) {
			for (const [year, file] of Object.entries(dataset.files ?? {})) {
				keep.add(this.fileKey(filePath(datasetKey, year), file.hash))
			}
		}
		await store.sweep(this.filePrefix(), keep).catch(() => undefined)
	}
}

export type { ICacheStore }
