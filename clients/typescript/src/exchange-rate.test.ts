/**
 * Runs against the real files in docs/, not fixtures: the point of these tests is that the
 * client decodes what the Go encoder actually published, so a format drift fails here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createPublicBusinessData } from './index'
import { MemoryStore } from './cache'

const DOCS_DIR = join(import.meta.dirname, '../../../docs')

/** Serves docs/ over a fake fetch, counting requests so caching can be asserted. */
function docsFetch() {
	const requested: string[] = []
	const fetchImpl = (async (url: string | URL) => {
		const path = String(url).replace('https://public-business-data.un.pe/', '')
		requested.push(path)
		try {
			const bytes = await readFile(join(DOCS_DIR, path))
			return new Response(new Uint8Array(bytes), { status: 200 })
		} catch {
			return new Response('not found', { status: 404 })
		}
	}) as unknown as typeof globalThis.fetch

	return { fetchImpl, requested }
}

describe('SunatExchangeRate', () => {
	it('describe el dataset desde el manifest', async () => {
		const { fetchImpl } = docsFetch()
		const dataset = await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.describe()

		expect(dataset.scale).toBe(1000)
		expect(dataset.unit).toBe('PEN por 1 USD')
		expect(await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.availableYears())
			.toEqual(['2021', '2022', '2023', '2024', '2025', '2026'])
	})

	it('lee un día y lo entrega en decimal y en escala', async () => {
		const { fetchImpl } = docsFetch()
		const day = await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.at('2026-09-20')

		expect(day).not.toBeNull()
		// El valor que publica https://www.sunat.gob.pe/a/txt/tipoCambio.txt ese día.
		expect(day?.buyScaled).toBe(3354)
		expect(day?.sellScaled).toBe(3362)
		expect(day?.buy).toBe(3.354)
		expect(day?.sell).toBe(3.362)
		expect(day?.date).toBe('2026-09-20')
	})

	it('devuelve null en un día sin publicación', async () => {
		const { fetchImpl } = docsFetch()
		// 2021-01-02 fue sábado y ese año la fuente no rellena fines de semana.
		const day = await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.at('2021-01-02')
		expect(day).toBeNull()
	})

	it('un rango cruza años y sale ordenado', async () => {
		const { fetchImpl } = docsFetch()
		const days = await createPublicBusinessData({ fetch: fetchImpl })
			.sunatExchangeRate.range('2024-12-30', '2025-01-03')

		expect(days.length).toBeGreaterThan(3)
		expect(days[0]?.date).toBe('2024-12-30')
		expect(days.at(-1)?.date.startsWith('2025-01')).toBe(true)
		for (let index = 1; index < days.length; index++) {
			expect(days[index]!.unixDay).toBeGreaterThan(days[index - 1]!.unixDay)
		}
	})

	it('sólo descarga los años que el rango toca', async () => {
		const { fetchImpl, requested } = docsFetch()
		await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.range('2023-03-01', '2023-03-31')

		expect(requested).toEqual(['manifest.json', 'sunat-usd-pen/2023.gz'])
	})

	it('no vuelve a descargar un año ya cargado', async () => {
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		await data.sunatExchangeRate.at('2024-03-15')
		await data.sunatExchangeRate.at('2024-08-20')
		await data.sunatExchangeRate.range('2024-01-01', '2024-12-31')

		expect(requested.filter((path) => path.endsWith('2024.gz'))).toHaveLength(1)
	})

	it('latest devuelve el último día publicado', async () => {
		const { fetchImpl } = docsFetch()
		const latest = await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.latest()

		expect(latest?.date).toBe('2026-09-21')
	})

	it('monthArrays entrega la forma que espera genix', async () => {
		const { fetchImpl } = docsFetch()
		const { buy, sell } = await createPublicBusinessData({ fetch: fetchImpl })
			.sunatExchangeRate.monthArrays(2026, 9)

		expect(buy).toHaveLength(31)
		expect(sell).toHaveLength(31)
		// Índice 19 es el día 20, y son enteros ×1000 como los guarda finance.ExchangeRate.
		expect(buy[19]).toBe(3354)
		expect(sell[19]).toBe(3362)
		// Septiembre tiene 30 días: el slot 31 nunca se llena.
		expect(buy[30]).toBe(0)
		// Los días posteriores al último publicado quedan en 0, que es lo que genix pinta vacío.
		expect(buy[29]).toBe(0)
	})

	it('reutiliza el caché persistente entre instancias sin tocar la red', async () => {
		// Un MemoryStore compartido es lo que IndexedDB hace entre recargas de la página.
		const cache = new MemoryStore()

		const first = docsFetch()
		await createPublicBusinessData({ fetch: first.fetchImpl, cache }).sunatExchangeRate.at('2025-06-10')
		expect(first.requested).toContain('sunat-usd-pen/2025.gz')

		const second = docsFetch()
		const day = await createPublicBusinessData({ fetch: second.fetchImpl, cache }).sunatExchangeRate.at('2025-06-10')

		expect(day).not.toBeNull()
		// Ni el manifest: dentro de la ventana también sale del caché.
		expect(second.requested).toEqual([])
	})

	it('rechaza un año que no coincide con lo que declara el manifest', async () => {
		// Un commit a medias — manifest nuevo, .gz viejo — no puede pasar como dato bueno.
		const fetchImpl = (async (url: string | URL) => {
			const path = String(url).replace('https://public-business-data.un.pe/', '')
			if (path === 'manifest.json') {
				const manifest = JSON.parse(await readFile(join(DOCS_DIR, 'manifest.json'), 'utf8'))
				manifest.datasets['sunat-usd-pen'].files['2026'].records = 999
				return new Response(JSON.stringify(manifest), { status: 200 })
			}
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		}) as unknown as typeof globalThis.fetch

		await expect(
			createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.at('2026-09-20'),
		).rejects.toThrow(/declara 999/)
	})

	it('el manifest se pide una sola vez dentro del TTL', async () => {
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		await Promise.all([
			data.sunatExchangeRate.at('2026-09-18'),
			data.sunatExchangeRate.at('2026-09-19'),
			data.sunatExchangeRate.availableYears(),
		])

		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(1)
	})

	it('refresh fuerza a releer el manifest', async () => {
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		await data.sunatExchangeRate.availableYears()
		data.refresh()
		await data.sunatExchangeRate.availableYears()

		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(2)
	})
})

describe('gunzip', () => {
	it('deja pasar un payload que ya venía sin comprimir', async () => {
		const { gunzip } = await import('./binfmt')
		const plain = new Uint8Array([1, 2, 3, 4])
		expect(await gunzip(plain)).toEqual(plain)
	})

	it('descomprime los .gz reales de docs/', async () => {
		const { gunzip } = await import('./binfmt')
		const bytes = new Uint8Array(await readFile(join(DOCS_DIR, 'sunat-usd-pen/2025.gz')))

		expect(bytes[0]).toBe(0x1f)
		const payload = await gunzip(bytes)
		expect(payload.byteLength % 10).toBe(0)
		expect(payload.byteLength / 10).toBe(365)
	})
})

describe('toUnixDay', () => {
	it('no se corre con la zona horaria local', async () => {
		const { toDateString, toUnixDay } = await import('./binfmt')
		vi.stubEnv('TZ', 'America/Lima')

		expect(toDateString(toUnixDay('2026-09-20'))).toBe('2026-09-20')
		expect(toUnixDay('1970-01-01')).toBe(0)
		// 2026-01-01 es el 20454 (firstDay que escribió el codificador Go) + 262 días.
		expect(toUnixDay('2026-09-20')).toBe(20716)
	})
})
