/**
 * The manifest is the entry point: it says which years exist and carries the hash that decides
 * whether a cached year is still current. Everything else the client does starts from here.
 */

import { toDateString } from './binfmt'
import { openCacheStore, type ICacheStore } from './cache'
import { describeDataset, PROVISIONAL_DESCRIPTION } from './descriptions'

/**
 * The shape published at `manifest.json`: an index and nothing else.
 *
 * One letter per field and no prose, because this file is fetched by every client on every cache
 * miss and its whole job is to answer "which years exist and did any of them move?". What each
 * dataset means does not change between publishes, so it lives in descriptions.ts instead. The
 * types below are what the client exposes; this is what crosses the wire.
 */
interface IWireFile {
	/** hash — FNV-1a 64 of the uncompressed payload. */
	h: string
	/** records. */
	r: number
	/** the last day, as a unixDay — the same unit every record carries. */
	d: number
}

interface IWireManifest {
	version: number
	generated: number
	datasets: Record<string, Record<string, IWireFile>>
	/** Per dataset, the unixDays that did not come from its own source. Absent when there are none. */
	provisional?: Record<string, number[]>
}

/** The manifest shape this build reads. A different one is an error, not a partial read. */
export const MANIFEST_VERSION = 2

/** One published year. The path is not stored — it is `${datasetKey}/${year}.gz`. */
export interface IManifestFile {
	/** FNV-1a 64 of the uncompressed payload. The cache key, and the lambda's change detector. */
	hash: string
	records: number
	/** Expanded from the published unixDay, because that is what a consumer wants to compare. */
	lastDate: string
}

/**
 * The days in a dataset that did not come from its own source, and where they did come from.
 *
 * The dates travel in the manifest — they change on every publish — and the prose comes from
 * descriptions.ts. They live in the index and not in the records because they are at most a
 * handful of days: a byte per record would cost 10 % of every file forever to mark three days,
 * and would break every decoder already written against the 10-byte layout.
 */
export interface IManifestProvisional {
	source: string
	sourceUrl: string
	note: string
	/** ISO dates, ascending. */
	dates: string[]
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
	/** Absent when every published day came from the dataset's own source, which is the norm. */
	provisional?: IManifestProvisional
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

/**
 * Turns the published index into what the rest of the client works with: prose from
 * descriptions.ts, dates expanded from unixDays, one object per dataset.
 *
 * Done once per manifest load rather than lazily per lookup — it is a dozen small objects, and
 * doing it here means nothing downstream has to know the wire format exists.
 */
function expand(wire: IWireManifest): IManifest {
	if (wire?.version !== MANIFEST_VERSION) {
		throw new Error(
			`manifest.json está en la versión ${wire?.version} y este cliente lee la ` +
				`${MANIFEST_VERSION}. Actualiza @ivanjoz/public-business-data.`,
		)
	}

	const datasets: Record<string, IManifestDataset> = {}
	for (const [datasetKey, years] of Object.entries(wire.datasets ?? {})) {
		const files: Record<string, IManifestFile> = {}
		for (const [year, file] of Object.entries(years)) {
			files[year] = { hash: file.h, records: file.r, lastDate: toDateString(file.d) }
		}

		const flagged = wire.provisional?.[datasetKey]
		datasets[datasetKey] = {
			...describeDataset(datasetKey),
			files,
			...(flagged?.length
				? { provisional: { ...PROVISIONAL_DESCRIPTION, dates: flagged.map(toDateString) } }
				: {}),
		}
	}
	return { version: wire.version, generated: wire.generated, datasets }
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

		// The cache holds the published bytes, not the expanded view: what is stored stays exactly
		// what was served, so a client that changes how it expands does not have to invalidate it.
		if (storedIsFresh) {
			return this.adopt(expand(JSON.parse(textDecoder.decode(stored.bytes))), stored.fetchedAt)
		}

		let wire: IWireManifest
		try {
			const response = await this.fetchImpl(this.url('manifest.json'))
			if (!response.ok) throw new Error(`GET manifest.json respondió ${response.status}`)
			const text = await response.text()
			wire = JSON.parse(text) as IWireManifest
			await store.put(key, textEncoder.encode(text)).catch(() => undefined)
		} catch (error) {
			// Stale beats nothing: the data is a historical series, so an expired manifest still
			// answers every question except "what happened today".
			if (stored) return this.adopt(expand(JSON.parse(textDecoder.decode(stored.bytes))), stored.fetchedAt)
			throw error
		}

		// Expanded outside the try on purpose. A manifest this build cannot read is not a network
		// failure, and answering it with the stale copy would hide "actualiza el cliente" behind
		// data that still happens to work.
		const fetched = expand(wire)

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
