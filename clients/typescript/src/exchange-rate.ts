/**
 * The SUNAT exchange rate dataset: what a consumer actually calls. Years are downloaded lazily
 * and kept keyed by the manifest hash, so a year that has not changed is never fetched twice
 * and a year that did changes key on its own without touching the others.
 */

import { RateYear, toDateString, toUnixDay, gunzip, type IExchangeRateDay } from './binfmt'
import { filePath, type IManifestDataset, ManifestStore } from './manifest'

/** The dataset key, which is also the folder its year files live in. */
export const SUNAT_USD_PEN = 'sunat-usd-pen'

/** The longest month, and so how many slots a month of rates carries. */
const DAYS_PER_MONTH_MAX = 31

export class SunatExchangeRate {
	private readonly years = new Map<string, RateYear>()
	/** Which manifest hash each decoded year came from — the test for "is my copy stale?". */
	private readonly loadedHashes = new Map<string, string>()
	/**
	 * Loads already running, by year. range() and lastYears() ask for several years at once, so
	 * without this two overlapping calls would each download the year they share.
	 */
	private readonly loading = new Map<string, Promise<RateYear | undefined>>()

	constructor(private readonly manifests: ManifestStore) {}

	/** What the manifest says about this dataset: source, unit, scale, years available. */
	async describe(): Promise<IManifestDataset> {
		const manifest = await this.manifests.get()
		const dataset = manifest.datasets[SUNAT_USD_PEN]
		if (!dataset) throw new Error(`el manifest no publica ${SUNAT_USD_PEN}`)
		return dataset
	}

	/** The years published, ascending. */
	async availableYears(): Promise<string[]> {
		return Object.keys((await this.describe()).files).sort()
	}

	/** One day, or null when SUNAT published nothing that day — a holiday or a weekend. */
	async at(date: string): Promise<IExchangeRateDay | null> {
		const year = await this.loadYear(date.slice(0, 4))
		if (!year) return null

		const index = year.indexOf(toUnixDay(date))
		return index < 0 ? null : year.at(index)
	}

	/**
	 * The last published day. Reads the last year the manifest names rather than assuming it is
	 * the current one, so this still answers on the 1st of January before that day is published.
	 */
	async latest(): Promise<IExchangeRateDay | null> {
		const years = await this.availableYears()
		for (const yearKey of years.reverse()) {
			const year = await this.loadYear(yearKey)
			if (year && year.length > 0) return year.at(year.length - 1)
		}
		return null
	}

	/**
	 * Every published day in [from, to], both inclusive. Downloads only the years it spans, and
	 * downloads them at once: a five-year range is five files, and asking for them one after the
	 * other would pay five round trips to fetch eight kilobytes.
	 */
	async range(from: string, to: string): Promise<IExchangeRateDay[]> {
		const fromUnixDay = toUnixDay(from)
		const toUnixDayValue = toUnixDay(to)
		if (fromUnixDay > toUnixDayValue) return []

		const yearKeys: string[] = []
		for (let yearNumber = Number(from.slice(0, 4)); yearNumber <= Number(to.slice(0, 4)); yearNumber++) {
			yearKeys.push(String(yearNumber))
		}
		const years = await Promise.all(yearKeys.map((yearKey) => this.loadYear(yearKey)))

		const days: IExchangeRateDay[] = []
		for (const year of years) {
			if (year) days.push(...year.slice(fromUnixDay, toUnixDayValue))
		}
		return days
	}

	/**
	 * The last `yearsAgo` years of published rates, in one call.
	 *
	 * The window is anchored on the last published day, not on the machine's clock: that makes
	 * the answer a property of the data — reproducible, and unaffected by a skewed clock or by a
	 * timezone ahead of Lima. It also catches the rates SUNAT publishes a day early over a
	 * weekend, which a `to` of "today" would silently cut off.
	 *
	 * `lastYears(5)` on a series ending 2026-09-21 is 2021-09-21 → 2026-09-21, so it spans six
	 * year files: five whole years, not five calendar years.
	 */
	async lastYears(yearsAgo: number): Promise<IExchangeRateDay[]> {
		if (!Number.isFinite(yearsAgo) || yearsAgo < 1) {
			throw new Error(`yearsAgo debe ser 1 o más, se recibió ${yearsAgo}`)
		}

		const lastDate = await this.lastPublishedDate()
		if (!lastDate) return []

		const end = new Date(`${lastDate}T00:00:00Z`)
		const start = new Date(
			Date.UTC(end.getUTCFullYear() - Math.floor(yearsAgo), end.getUTCMonth(), end.getUTCDate()),
		)
		return this.range(start.toISOString().slice(0, 10), lastDate)
	}

	/**
	 * The last day the dataset covers, read straight from the manifest — no year file has to be
	 * downloaded to know where the series ends.
	 */
	async lastPublishedDate(): Promise<string | undefined> {
		const dataset = await this.describe()
		let lastDate: string | undefined
		for (const file of Object.values(dataset.files)) {
			if (file.lastDate && (!lastDate || file.lastDate > lastDate)) lastDate = file.lastDate
		}
		return lastDate
	}

	/**
	 * A month as two 31-slot arrays of scaled rates, with 0 where nothing was published.
	 *
	 * That is exactly the shape and scale of `DetailBuyRate` / `DetailSellRate` in genix's
	 * `finance.ExchangeRate`, so filling a month there is an assignment and not a conversion —
	 * and genix's 0 already means "no rate for this day", the same thing it means here.
	 *
	 * @param month 1 = January.
	 */
	async monthArrays(year: number, month: number): Promise<{ buy: number[]; sell: number[] }> {
		const buy = new Array<number>(DAYS_PER_MONTH_MAX).fill(0)
		const sell = new Array<number>(DAYS_PER_MONTH_MAX).fill(0)

		const monthStart = `${year}-${String(month).padStart(2, '0')}`
		// Day 0 of the next month is the last day of this one.
		const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

		for (const day of await this.range(`${monthStart}-01`, `${monthStart}-${lastDay}`)) {
			const dayOfMonth = Number(day.date.slice(8, 10))
			buy[dayOfMonth - 1] = day.buyScaled
			sell[dayOfMonth - 1] = day.sellScaled
		}
		return { buy, sell }
	}

	/**
	 * Loads a year, from memory, then from the persistent cache, then from the network. The
	 * manifest hash is the whole cache protocol: a year keeps its bytes until its hash moves.
	 */
	private async loadYear(yearKey: string): Promise<RateYear | undefined> {
		const dataset = await this.describe()
		const entry = dataset.files[yearKey]
		if (!entry) return undefined

		if (this.loadedHashes.get(yearKey) === entry.hash) return this.years.get(yearKey)

		const running = this.loading.get(yearKey)
		if (running) return running

		const load = this.fetchYear(yearKey, entry.hash, entry.records).finally(() => {
			this.loading.delete(yearKey)
		})
		this.loading.set(yearKey, load)
		return load
	}

	private async fetchYear(yearKey: string, hash: string, records: number): Promise<RateYear> {
		const path = filePath(SUNAT_USD_PEN, yearKey)
		const cacheKey = this.manifests.fileKey(path, hash)
		const store = await this.manifests.cache()

		// The key carries the hash, so a hit is by definition the year the manifest is naming:
		// there is no expiry to check and no revalidation request to make.
		let payload = (await store.get(cacheKey).catch(() => undefined))?.bytes

		if (!payload) {
			payload = await gunzip(await this.manifests.fetchBytes(path))
			// A file that does not hold what the manifest promised is a half-published commit or
			// a corrupted download; caching it would make the mistake stick.
			if (payload.byteLength !== records * 10) {
				throw new Error(
					`${yearKey}.gz trae ${payload.byteLength / 10} días y el manifest declara ${records}`,
				)
			}
			await store.put(cacheKey, payload).catch(() => undefined)
		}

		const year = new RateYear(payload)
		this.years.set(yearKey, year)
		this.loadedHashes.set(yearKey, hash)
		return year
	}
}

export { toDateString, toUnixDay, type IExchangeRateDay }
