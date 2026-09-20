/**
 * The bulk read: lastYears(), the window it picks, and that it goes for the year files in
 * parallel instead of one after the other.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { MemoryStore } from './cache'
import { createPublicBusinessData } from './index'

const DOCS_DIR = join(import.meta.dirname, '../../../docs')

/** Serves docs/ and records when each request starts and ends, to tell parallel from serial. */
function docsFetch(delayMs = 0) {
	const requested: string[] = []
	let inFlight = 0
	let maxInFlight = 0

	const fetchImpl = (async (url: string | URL) => {
		const path = String(url).replace('https://public-business-data.un.pe/', '')
		requested.push(path)
		inFlight++
		maxInFlight = Math.max(maxInFlight, inFlight)
		try {
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		} catch {
			return new Response('not found', { status: 404 })
		} finally {
			inFlight--
		}
	}) as unknown as typeof globalThis.fetch

	return { fetchImpl, requested, peakInFlight: () => maxInFlight }
}

function client(fetchImpl: typeof globalThis.fetch) {
	return createPublicBusinessData({ fetch: fetchImpl, cache: new MemoryStore() })
}

describe('getSunatRateYears', () => {
	it('devuelve la ventana anclada al último día publicado', async () => {
		const { fetchImpl } = docsFetch()
		const days = await client(fetchImpl).sunatExchangeRate.lastYears(5)

		// El dataset termina el 2026-09-21, así que 5 años atrás es el 2021-09-21.
		expect(days[0]?.date).toBe('2021-09-21')
		expect(days.at(-1)?.date).toBe('2026-09-21')
	})

	it('sale ordenado y sin repetir días', async () => {
		const { fetchImpl } = docsFetch()
		const days = await client(fetchImpl).sunatExchangeRate.lastYears(3)

		expect(days.length).toBeGreaterThan(900)
		for (let index = 1; index < days.length; index++) {
			expect(days[index]!.unixDay).toBeGreaterThan(days[index - 1]!.unixDay)
		}
	})

	it('5 años cruzan 6 archivos: son años completos, no años calendario', async () => {
		const { fetchImpl, requested } = docsFetch()
		await client(fetchImpl).sunatExchangeRate.lastYears(5)

		const downloaded = requested.filter((path) => path.endsWith('.gz')).sort()
		expect(downloaded).toEqual([
			'sunat-usd-pen/2021.gz',
			'sunat-usd-pen/2022.gz',
			'sunat-usd-pen/2023.gz',
			'sunat-usd-pen/2024.gz',
			'sunat-usd-pen/2025.gz',
			'sunat-usd-pen/2026.gz',
		])
	})

	it('no pide años anteriores al inicio de la serie', async () => {
		const { fetchImpl, requested } = docsFetch()
		// 20 años atrás cae muy antes de 2021: los archivos que no existen no se piden.
		const days = await client(fetchImpl).sunatExchangeRate.lastYears(20)

		expect(days[0]?.date).toBe('2021-01-01')
		expect(requested.filter((path) => path.endsWith('.gz'))).toHaveLength(6)
	})

	it('1 año devuelve sólo los últimos doce meses', async () => {
		const { fetchImpl } = docsFetch()
		const days = await client(fetchImpl).sunatExchangeRate.lastYears(1)

		expect(days[0]?.date).toBe('2025-09-21')
		expect(days.at(-1)?.date).toBe('2026-09-21')
		expect(days.length).toBeLessThan(380)
	})

	it('descarga los años en paralelo, no uno tras otro', async () => {
		const { fetchImpl, peakInFlight } = docsFetch(15)
		await client(fetchImpl).sunatExchangeRate.lastYears(5)

		// En serie el pico sería 1; con Promise.all son los 6 archivos a la vez.
		expect(peakInFlight()).toBeGreaterThan(1)
	})

	it('no baja dos veces el año que comparten dos llamadas concurrentes', async () => {
		const { fetchImpl, requested } = docsFetch(15)
		const data = client(fetchImpl)

		await Promise.all([
			data.sunatExchangeRate.lastYears(2),
			data.sunatExchangeRate.range('2025-01-01', '2025-12-31'),
			data.sunatExchangeRate.at('2025-06-06'),
		])

		expect(requested.filter((path) => path.endsWith('2025.gz'))).toHaveLength(1)
	})

	it('un yearsAgo inválido es un error, no una respuesta vacía', async () => {
		const { fetchImpl } = docsFetch()
		const data = client(fetchImpl)

		await expect(data.sunatExchangeRate.lastYears(0)).rejects.toThrow(/1 o más/)
		await expect(data.sunatExchangeRate.lastYears(-3)).rejects.toThrow(/1 o más/)
		await expect(data.sunatExchangeRate.lastYears(Number.NaN)).rejects.toThrow(/1 o más/)
	})

	it('lastPublishedDate no descarga ningún año', async () => {
		const { fetchImpl, requested } = docsFetch()
		const lastDate = await client(fetchImpl).sunatExchangeRate.lastPublishedDate()

		expect(lastDate).toBe('2026-09-21')
		expect(requested).toEqual(['manifest.json'])
	})
})
