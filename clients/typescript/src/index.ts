/**
 * Client for https://public-business-data.un.pe — static, gzipped binary datasets published on
 * GitHub Pages. No dependencies: it decompresses with DecompressionStream and caches in
 * IndexedDB, both of which browsers and Node already have.
 *
 * Imported as a module, used as plain functions:
 *
 *   import { getSunatRate, getSunatMonthArrays, setCache } from 'https://public-business-data.un.pe/client.mjs'
 *
 *   setCache(30)                              // minutos antes de volver a mirar el manifest
 *   await getSunatRate('2026-09-20')               // { buy: 3.354, buyScaled: 3354, ... }
 *   await getSunatMonthArrays(2026, 9)             // { buy: number[31], sell: number[31] }
 *
 * The import is static and the functions are async, because the data is downloaded on first
 * use. Nothing happens at import time: no request, no IndexedDB open, no work at all until a
 * function is called.
 */

import type { IExchangeRateDay } from './binfmt'
import { SunatExchangeRate } from './exchange-rate'
import {
	DEFAULT_BASE_URL,
	DEFAULT_CACHE_MINUTES,
	ManifestStore,
	type IClientOptions,
	type IManifestDataset,
} from './manifest'

export class PublicBusinessData {
	readonly manifests: ManifestStore
	readonly sunatExchangeRate: SunatExchangeRate

	constructor(options: IClientOptions = {}) {
		this.manifests = new ManifestStore(options)
		this.sunatExchangeRate = new SunatExchangeRate(this.manifests)
	}

	/** Minutes the manifest is trusted before being re-checked. */
	setCache(minutes: number): void {
		this.manifests.setCacheMinutes(minutes)
	}

	/** Forces the next read to re-check the manifest instead of waiting out the window. */
	refresh(): void {
		this.manifests.invalidate()
	}

	/** Empties IndexedDB: the manifest and every cached year. */
	clearCache(): Promise<void> {
		return this.manifests.clearCache()
	}
}

export function createPublicBusinessData(options: IClientOptions = {}): PublicBusinessData {
	return new PublicBusinessData(options)
}

// ─── API por defecto ────────────────────────────────────────────────────────
// A module-level instance so the common case is `import { getSunatRate }` and nothing else. It is
// built lazily: importing the module must not open IndexedDB or hit the network, because a
// bundle that did would pay for itself on every page that merely imports it.

let shared: PublicBusinessData | undefined
let sharedOptions: IClientOptions = {}

function instance(): PublicBusinessData {
	shared ??= new PublicBusinessData(sharedOptions)
	return shared
}

/**
 * How many minutes the manifest is reused before the client looks again. Default 20.
 *
 * It applies to the manifest and not to the year files on purpose: a year is cached under the
 * hash the manifest gives it, so it is immutable and never needs re-downloading. Re-checking
 * the manifest is what discovers a new hash, and the new hash is what pulls the new bytes.
 * Putting a clock on the payloads instead would re-download the whole history every 20 minutes
 * to find out that none of it moved.
 *
 * Pass 0 to always re-check.
 */
export function setCache(minutes: number): void {
	sharedOptions = { ...sharedOptions, cacheMinutes: minutes }
	shared?.setCache(minutes)
}

/** Minutes currently configured. */
export function getCache(): number {
	return shared ? shared.manifests.cacheMinutes() : (sharedOptions.cacheMinutes ?? DEFAULT_CACHE_MINUTES)
}

/**
 * Points the default instance somewhere else — a local docs/ copy, a fork, a staging origin.
 * Resets the instance, so anything already downloaded is dropped from memory (IndexedDB keeps
 * its entries: they are keyed by origin and cost nothing to leave behind).
 */
export function setBaseUrl(baseUrl: string): void {
	// Apuntar al mismo sitio no es un cambio. Sin esta salida, dos componentes que fijen el mismo
	// origen —lo normal: cada uno se basta a sí mismo y ninguno sabe del otro— tirarían la
	// instancia del otro y volverían a pedirlo todo, y el resultado dependería de en qué orden
	// se monten.
	const normalized = baseUrl.replace(/\/$/, '')
	if (normalized === (sharedOptions.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')) return

	sharedOptions = { ...sharedOptions, baseUrl: normalized }
	shared = undefined
}

/** Replaces fetch on the default instance. For tests and for a runtime with its own client. */
export function setFetch(fetchImpl: typeof globalThis.fetch): void {
	sharedOptions = { ...sharedOptions, fetch: fetchImpl }
	shared = undefined
}

/** Makes the next call re-check the manifest, ignoring the cache window. */
export function refresh(): void {
	instance().refresh()
}

/** Empties IndexedDB: the manifest and every cached year. */
export function clearCache(): Promise<void> {
	return instance().clearCache()
}

/**
 * When the published data last changed, as a Date.
 *
 * It is not the time of the last run: the updater only writes when a hash moved, so this stamp
 * moves with the data and not with the cron. Different from `getSunatLastPublishedDate`, which
 * is the last day the series covers — a rate for Monday can be published on Monday morning, so
 * one answers "hasta cuándo llegan los datos" and the other "cuándo se tocaron por última vez".
 *
 * Read from the manifest, so it costs nothing beyond the manifest itself.
 */
export async function getManifestGenerated(): Promise<Date> {
	const manifest = await instance().manifests.get()
	return new Date(manifest.generated * 1000)
}

/** The dataset's own description: source, unit, scale, years published. */
export function describeSunatExchangeRate(): Promise<IManifestDataset> {
	return instance().sunatExchangeRate.describe()
}

/** The years published, ascending. */
export function getSunatAvailableYears(): Promise<string[]> {
	return instance().sunatExchangeRate.availableYears()
}

/** One day, or null when SUNAT published nothing that day — a holiday or a weekend. */
export function getSunatRate(date: string): Promise<IExchangeRateDay | null> {
	return instance().sunatExchangeRate.at(date)
}

/** The last published day. */
export function getLatestSunatRate(): Promise<IExchangeRateDay | null> {
	return instance().sunatExchangeRate.latest()
}

/** Every published day in [from, to], both inclusive. Downloads only the years it spans. */
export function getSunatRateRange(from: string, to: string): Promise<IExchangeRateDay[]> {
	return instance().sunatExchangeRate.range(from, to)
}

/**
 * Bulk: the last `yearsAgo` years of rates in one call, oldest first. The year files it needs
 * are downloaded at once, not one after the other.
 *
 * The window ends at the last published day rather than at the machine's clock, so the answer
 * is a property of the data: reproducible, unaffected by a skewed clock, and it still includes
 * the day SUNAT publishes early over a weekend.
 *
 *   await getSunatRateYears(5)   // 2021-09-21 → 2026-09-21, ~1 800 días, 6 archivos, ~9 KB
 */
export function getSunatRateYears(yearsAgo: number): Promise<IExchangeRateDay[]> {
	return instance().sunatExchangeRate.lastYears(yearsAgo)
}

/** The last day the dataset covers. Read from the manifest: downloads no year file. */
export function getSunatLastPublishedDate(): Promise<string | undefined> {
	return instance().sunatExchangeRate.lastPublishedDate()
}

/**
 * A month as two 31-slot arrays of rates × 1000, with 0 where nothing was published — the exact
 * shape of `DetailBuyRate` / `DetailSellRate` in genix's `finance.ExchangeRate`.
 *
 * @param month 1 = January.
 */
export function getSunatMonthArrays(year: number, month: number): Promise<{ buy: number[]; sell: number[] }> {
	return instance().sunatExchangeRate.monthArrays(year, month)
}

export { SUNAT_USD_PEN, SunatExchangeRate } from './exchange-rate'
export { DEFAULT_BASE_URL, DEFAULT_CACHE_MINUTES, ManifestStore } from './manifest'
export { RECORD_SIZE, SCALE, RateYear, gunzip, toDateString, toUnixDay } from './binfmt'
export { MemoryStore, openCacheStore } from './cache'
export type { IExchangeRateDay } from './binfmt'
export type { ICacheStore } from './cache'
export type { IClientOptions, IManifest, IManifestDataset, IManifestFile } from './manifest'
