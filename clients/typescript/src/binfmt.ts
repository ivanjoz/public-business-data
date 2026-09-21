/**
 * The published binary format, mirrored from updater/binfmt. One record is 10 bytes, little
 * endian, and the file is sorted ascending by day — which is why lookups here binary-search the
 * buffer instead of building a Map.
 */

/** Bytes one published day occupies: int16 day + int32 buy + int32 sell. */
export const RECORD_SIZE = 10

/** The fixed-point factor every rate carries: 3.354 travels as 3354. */
export const SCALE = 1000

/** Milliseconds in a day — the only conversion between a unixDay and a Date. */
const MS_PER_DAY = 86_400_000

/** One published day, in both the form you show and the form you store. */
export interface IExchangeRateDay {
	/** ISO calendar date, '2026-09-18'. */
	date: string
	/** Days since the unix epoch, as stored. */
	unixDay: number
	/** Buy rate as a decimal, for display: 3.354. */
	buy: number
	/** Sell rate as a decimal, for display: 3.362. */
	sell: number
	/** Buy rate × 1000, as published and as genix stores it: 3354. */
	buyScaled: number
	/** Sell rate × 1000: 3362. */
	sellScaled: number
	/**
	 * True when this day did not come from the dataset's own source but from the reference fill,
	 * because the real source had not published it yet. Measured error against the BCRP: ±0,5 %.
	 *
	 * Never use a provisional day for anything that has to be right — invoicing, books, a
	 * settlement. It is overwritten by the real value as soon as it lands, and deleted if it never
	 * does. `describeBcrpExchangeRate().provisional` says where it came from.
	 */
	provisional: boolean
}

/** '2026-09-18' → 20714. Parsed as UTC so a local timezone can never shift the day. */
export function toUnixDay(date: string): number {
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY)
}

/** 20714 → '2026-09-18'. */
export function toDateString(unixDay: number): string {
	return new Date(unixDay * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * Decompresses a published file. GitHub Pages serves .gz as `Content-Type: application/gzip`
 * with no `Content-Encoding`, so the browser hands over raw gzip bytes and this has to undo it.
 * The magic-number check is what keeps that from being an assumption: if a CDN or proxy ever
 * does decode the transport encoding for us, the payload arrives already unwrapped and passes
 * straight through instead of failing with "incorrect header check".
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const isGzip = bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b
	if (!isGzip) return bytes

	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
	return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * A decoded year, kept as the raw payload rather than as objects. A year is ~360 records, so
 * this is less about speed than about not allocating 360 objects to answer a question about one.
 */
export class RateYear {
	private readonly view: DataView
	readonly length: number

	constructor(payload: Uint8Array) {
		if (payload.byteLength % RECORD_SIZE !== 0) {
			throw new Error(`payload de ${payload.byteLength} bytes: no es múltiplo de ${RECORD_SIZE}`)
		}
		this.view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
		this.length = payload.byteLength / RECORD_SIZE
	}

	/** The day stored at a position, without materialising the rest of the record. */
	unixDayAt(index: number): number {
		return this.view.getInt16(index * RECORD_SIZE, true)
	}

	/**
	 * The record at a position. `provisional` is always false here: the payload does not carry the
	 * flag — it is a handful of dates in the manifest, not a byte per record — so it is the dataset
	 * that stamps it after reading. See ExchangeRate.
	 */
	at(index: number): IExchangeRateDay {
		const offset = index * RECORD_SIZE
		const unixDay = this.view.getInt16(offset, true)
		const buyScaled = this.view.getInt32(offset + 2, true)
		const sellScaled = this.view.getInt32(offset + 6, true)
		return {
			date: toDateString(unixDay),
			unixDay,
			buy: buyScaled / SCALE,
			sell: sellScaled / SCALE,
			buyScaled,
			sellScaled,
			provisional: false,
		}
	}

	/** Position of a day, or -1. Binary search: the file is sorted and that is part of the format. */
	indexOf(unixDay: number): number {
		let low = 0
		let high = this.length - 1
		while (low <= high) {
			const middle = (low + high) >> 1
			const found = this.unixDayAt(middle)
			if (found === unixDay) return middle
			if (found < unixDay) low = middle + 1
			else high = middle - 1
		}
		return -1
	}

	/** Position of the first day at or after unixDay — where a range starts. */
	lowerBound(unixDay: number): number {
		let low = 0
		let high = this.length
		while (low < high) {
			const middle = (low + high) >> 1
			if (this.unixDayAt(middle) < unixDay) low = middle + 1
			else high = middle
		}
		return low
	}

	/** Every day in [fromUnixDay, toUnixDay], both inclusive. */
	slice(fromUnixDay: number, toUnixDay: number): IExchangeRateDay[] {
		const days: IExchangeRateDay[] = []
		for (let index = this.lowerBound(fromUnixDay); index < this.length; index++) {
			if (this.unixDayAt(index) > toUnixDay) break
			days.push(this.at(index))
		}
		return days
	}
}
