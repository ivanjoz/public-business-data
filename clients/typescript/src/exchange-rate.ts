/**
 * An exchange rate dataset: what a consumer actually calls. Years are downloaded lazily and kept
 * keyed by the manifest hash, so a year that has not changed is never fetched twice and a year
 * that did changes key on its own without touching the others.
 *
 * One class for every series, parameterized by the dataset key, because the two published today
 * differ only in where their bytes live: same record layout, same scale, same caching. What they
 * do not share is meaning — SUNAT's is the accounting rate the tax code points at, the BCRP's is
 * the interbank rate the market actually traded at — and that is why they are separate datasets
 * with separate functions instead of a flag on one.
 */

import { RateYear, toDateString, toUnixDay, gunzip, type IExchangeRateDay } from './binfmt'
import { BCRP_INTERBANCARIO_USD_PEN, SUNAT_USD_PEN } from './keys'
import { filePath, type IManifestDataset, ManifestStore } from './manifest'

export { BCRP_INTERBANCARIO_USD_PEN, SUNAT_USD_PEN }

/** The longest month, and so how many slots a month of rates carries. */
const DAYS_PER_MONTH_MAX = 31

/** The years a dataset entry names, ascending. */
function yearsOf(dataset: IManifestDataset): string[] {
	return Object.keys(dataset.files).sort()
}

/** Where the series ends according to the manifest, without opening a single year file. */
function lastDateOf(dataset: IManifestDataset): string | undefined {
	let lastDate: string | undefined
	for (const file of Object.values(dataset.files)) {
		if (file.lastDate && (!lastDate || file.lastDate > lastDate)) lastDate = file.lastDate
	}
	return lastDate
}

export class ExchangeRate {
	private readonly years = new Map<string, RateYear>()
	/** Which manifest hash each decoded year came from — the test for "is my copy stale?". */
	private readonly loadedHashes = new Map<string, string>()
	/**
	 * Loads already running, by year. range() and lastYears() ask for several years at once, so
	 * without this two overlapping calls would each download the year they share.
	 */
	private readonly loading = new Map<string, Promise<RateYear | undefined>>()

	constructor(
		private readonly manifests: ManifestStore,
		readonly datasetKey: string,
	) {}

	/** What the manifest says about this dataset: source, unit, scale, years available. */
	async describe(): Promise<IManifestDataset> {
		const manifest = await this.manifests.get()
		const dataset = manifest.datasets[this.datasetKey]
		if (!dataset) throw new Error(`el manifest no publica ${this.datasetKey}`)
		return dataset
	}

	/** The years published, ascending. */
	async availableYears(): Promise<string[]> {
		return yearsOf(await this.describe())
	}

	/**
	 * Stamps the provisional flag, which lives in the manifest and not in the payload.
	 *
	 * The dataset entry is passed in rather than fetched here, and that is the whole reason these
	 * methods read it once and thread it down: a second `describe()` inside the same call is free
	 * while the manifest is inside its cache window, and a second HTTP request the moment someone
	 * sets `setCache(0)`.
	 */
	private mark(days: IExchangeRateDay[], dataset: IManifestDataset): IExchangeRateDay[] {
		const dates = dataset.provisional?.dates
		if (!dates || dates.length === 0) return days

		const flagged = new Set(dates.map(toUnixDay))
		for (const day of days) {
			if (flagged.has(day.unixDay)) day.provisional = true
		}
		return days
	}

	/** One day, or null when the source published nothing that day — a holiday or a weekend. */
	async at(date: string): Promise<IExchangeRateDay | null> {
		const dataset = await this.describe()
		const year = await this.loadYear(date.slice(0, 4), dataset)
		if (!year) return null

		const index = year.indexOf(toUnixDay(date))
		if (index < 0) return null
		return this.mark([year.at(index)], dataset)[0]!
	}

	/**
	 * The last published day. Reads the last year the manifest names rather than assuming it is
	 * the current one, so this still answers on the 1st of January before that day is published.
	 */
	async latest(): Promise<IExchangeRateDay | null> {
		const dataset = await this.describe()
		for (const yearKey of yearsOf(dataset).reverse()) {
			const year = await this.loadYear(yearKey, dataset)
			if (year && year.length > 0) {
				// The last day is the likeliest one to be provisional: it is the one the real
				// source has not caught up with yet.
				return this.mark([year.at(year.length - 1)], dataset)[0]!
			}
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

		const dataset = await this.describe()
		const yearKeys: string[] = []
		for (let yearNumber = Number(from.slice(0, 4)); yearNumber <= Number(to.slice(0, 4)); yearNumber++) {
			yearKeys.push(String(yearNumber))
		}
		const years = await Promise.all(yearKeys.map((yearKey) => this.loadYear(yearKey, dataset)))

		const days: IExchangeRateDay[] = []
		for (const year of years) {
			if (year) days.push(...year.slice(fromUnixDay, toUnixDayValue))
		}
		return this.mark(days, dataset)
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
		return lastDateOf(await this.describe())
	}

	/**
	 * The last day that came from the dataset's own source — the last one you can rely on.
	 *
	 * Different from `lastPublishedDate` only while a fill is in place: that one answers "hasta
	 * dónde llega la serie" contando los provisionales, and this one "hasta dónde llega el dato
	 * confirmado". While nothing is filled — the normal state — the two agree and neither
	 * downloads a year file.
	 */
	async lastConfirmedDate(): Promise<string | undefined> {
		const dataset = await this.describe()
		const flagged = new Set(dataset.provisional?.dates ?? [])

		const lastDate = lastDateOf(dataset)
		if (!lastDate || !flagged.has(lastDate)) return lastDate

		// The tail is provisional, so the answer is a day the manifest does not name and only the
		// payload knows. Walking back from the end of the last non-empty year finds it exactly,
		// without assuming which calendar days the series happens to have.
		for (const yearKey of yearsOf(dataset).reverse()) {
			const year = await this.loadYear(yearKey, dataset)
			if (!year) continue
			for (let index = year.length - 1; index >= 0; index--) {
				const date = toDateString(year.unixDayAt(index))
				if (!flagged.has(date)) return date
			}
		}
		return undefined
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
	async monthArrays(
		year: number,
		month: number,
	): Promise<{ buy: number[]; sell: number[]; provisional: boolean[] }> {
		const buy = new Array<number>(DAYS_PER_MONTH_MAX).fill(0)
		const sell = new Array<number>(DAYS_PER_MONTH_MAX).fill(0)
		// The third array is not decoration: this is the shape that gets fed straight into a
		// finance table, and it is the one place where an approximate rate would otherwise arrive
		// as a bare number with nothing left to say it is not confirmed.
		const provisional = new Array<boolean>(DAYS_PER_MONTH_MAX).fill(false)

		const monthStart = `${year}-${String(month).padStart(2, '0')}`
		// Day 0 of the next month is the last day of this one.
		const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()

		for (const day of await this.range(`${monthStart}-01`, `${monthStart}-${lastDay}`)) {
			const dayOfMonth = Number(day.date.slice(8, 10))
			buy[dayOfMonth - 1] = day.buyScaled
			sell[dayOfMonth - 1] = day.sellScaled
			provisional[dayOfMonth - 1] = day.provisional
		}
		return { buy, sell, provisional }
	}

	/**
	 * Loads a year, from memory, then from the persistent cache, then from the network. The
	 * manifest hash is the whole cache protocol: a year keeps its bytes until its hash moves.
	 */
	private async loadYear(yearKey: string, dataset: IManifestDataset): Promise<RateYear | undefined> {
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
		const path = filePath(this.datasetKey, yearKey)
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

/**
 * The rate SUNAT publishes: the SBS system average of the previous business day, and the one the
 * tax code points at for invoicing, books and year-end translation.
 */
export class SunatExchangeRate extends ExchangeRate {
	constructor(manifests: ManifestStore) {
		super(manifests, SUNAT_USD_PEN)
	}
}

/**
 * The BCRP's interbank rate: what banks actually traded dollars at, which is the closest thing to
 * a market price any Peruvian public API publishes. Two things to expect from it — it is *not*
 * what you pay at a bank or a casa de cambio, which adds its own spread, and BCRPData posts it
 * with a couple of business days' lag, so its last day is usually behind SUNAT's.
 */
export class BcrpExchangeRate extends ExchangeRate {
	constructor(manifests: ManifestStore) {
		super(manifests, BCRP_INTERBANCARIO_USD_PEN)
	}
}

export { toDateString, toUnixDay, type IExchangeRateDay }
