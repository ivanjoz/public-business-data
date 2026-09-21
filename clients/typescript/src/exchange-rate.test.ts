/**
 * Runs against the real files in docs/, not fixtures: the point of these tests is that the
 * client decodes what the Go encoder actually published, so a format drift fails here.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createPublicBusinessData, MANIFEST_VERSION } from './index'
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
				manifest.datasets['sunat-usd-pen']['2026'].r = 999
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

describe('BcrpExchangeRate', () => {
	it('describe el dataset del interbancario', async () => {
		const { fetchImpl } = docsFetch()
		const dataset = await createPublicBusinessData({ fetch: fetchImpl }).bcrpExchangeRate.describe()

		// Misma escala y mismo layout que SUNAT: lo que cambia es de dónde salen los números.
		expect(dataset.scale).toBe(1000)
		expect(dataset.unit).toBe('PEN por 1 USD')
		expect(dataset.source).toContain('BCRP')
		expect(dataset.source).toContain('PD04637PD')
	})

	it('lee un día del interbancario redondeado a 3 decimales', async () => {
		const { fetchImpl } = docsFetch()
		const day = await createPublicBusinessData({ fetch: fetchImpl }).bcrpExchangeRate.at('2026-09-17')

		// El BCRP responde 3.36214285714286 / 3.36371428571429, y declara la serie con 3 decimales.
		expect(day?.buyScaled).toBe(3362)
		expect(day?.sellScaled).toBe(3364)
		expect(day?.date).toBe('2026-09-17')
	})

	it('los dos datasets comparten el manifest y se piden por separado', async () => {
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		await Promise.all([data.sunatExchangeRate.at('2026-09-17'), data.bcrpExchangeRate.at('2026-09-17')])

		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(1)
		expect(requested).toContain('sunat-usd-pen/2026.gz')
		expect(requested).toContain('bcrp-interbancario-usd-pen/2026.gz')
	})

	it('el interbancario y el de SUNAT no coinciden el mismo día', async () => {
		// No es un detalle de implementación sino la razón de que sean dos datasets: SUNAT publica
		// el cierre SBS del día hábil anterior y el BCRP el promedio del mercado de ese día.
		const { fetchImpl } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		const [sunat, bcrp] = await Promise.all([
			data.sunatExchangeRate.at('2026-09-17'),
			data.bcrpExchangeRate.at('2026-09-17'),
		])
		expect(sunat).not.toBeNull()
		expect(bcrp).not.toBeNull()
		expect(bcrp?.buyScaled).not.toBe(sunat?.buyScaled)
	})

	it('un rango del interbancario sale ordenado y sin fines de semana', async () => {
		const { fetchImpl } = docsFetch()
		const days = await createPublicBusinessData({ fetch: fetchImpl })
			.bcrpExchangeRate.range('2026-09-01', '2026-09-30')

		expect(days.length).toBeGreaterThan(10)
		for (let index = 1; index < days.length; index++) {
			expect(days[index]!.unixDay).toBeGreaterThan(days[index - 1]!.unixDay)
		}
		// 2026-09-05 fue sábado: el mercado no operó y el día no está en la serie.
		expect(days.some((day) => day.date === '2026-09-05')).toBe(false)
	})

	it('marca el día provisional y deja el resto sin marcar', async () => {
		const { fetchImpl } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		// 2026-09-18 es el viernes que el BCRP todavía no había publicado: va relleno.
		const filled = await data.bcrpExchangeRate.at('2026-09-18')
		expect(filled?.provisional).toBe(true)

		const real = await data.bcrpExchangeRate.at('2026-09-17')
		expect(real?.provisional).toBe(false)

		// El otro dataset no tiene relleno y ningún día suyo puede salir marcado.
		expect((await data.sunatExchangeRate.at('2026-09-18'))?.provisional).toBe(false)
	})

	it('el manifest explica de dónde sale el relleno', async () => {
		const { fetchImpl } = docsFetch()
		const dataset = await createPublicBusinessData({ fetch: fetchImpl }).bcrpExchangeRate.describe()

		expect(dataset.provisional?.dates).toContain('2026-09-18')
		expect(dataset.provisional?.source).toBeTruthy()
		// La nota es lo que lee quien consume el manifest en crudo, sin este cliente.
		expect(dataset.provisional?.note).toMatch(/no son oficiales/i)
	})

	it('un rango marca sólo los días de relleno que contiene', async () => {
		const { fetchImpl } = docsFetch()
		const days = await createPublicBusinessData({ fetch: fetchImpl })
			.bcrpExchangeRate.range('2026-09-14', '2026-09-18')

		const flagged = days.filter((day) => day.provisional).map((day) => day.date)
		expect(flagged).toEqual(['2026-09-18'])
		expect(days.length).toBeGreaterThan(1)
	})

	it('monthArrays trae la pista de qué slots son provisionales', async () => {
		const { fetchImpl } = docsFetch()
		const { buy, provisional } = await createPublicBusinessData({ fetch: fetchImpl })
			.bcrpExchangeRate.monthArrays(2026, 9)

		expect(provisional).toHaveLength(31)
		// Índice 17 es el día 18. Sin esta pista, el valor entraría en una tabla financiera como
		// un número más y nada diría que no está confirmado.
		expect(provisional[17]).toBe(true)
		expect(buy[17]).toBeGreaterThan(0)
		expect(provisional[16]).toBe(false)
	})

	it('lastConfirmedDate se queda en el último día real, lastPublishedDate no', async () => {
		const { fetchImpl } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		expect(await data.bcrpExchangeRate.lastPublishedDate()).toBe('2026-09-18')
		expect(await data.bcrpExchangeRate.lastConfirmedDate()).toBe('2026-09-17')

		// Sin relleno las dos responden lo mismo, y ninguna baja un año para hacerlo.
		expect(await data.sunatExchangeRate.lastConfirmedDate()).toBe(
			await data.sunatExchangeRate.lastPublishedDate(),
		)
	})

	it('el flag no cuesta una segunda lectura del manifest', async () => {
		// Con la ventana en 0 cada describe() es una petición, así que un método que lo pida dos
		// veces se ve aquí y en ningún otro sitio.
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl, cacheMinutes: 0 })

		await data.bcrpExchangeRate.at('2026-09-18')

		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(1)
	})

	it('lastPublishedDate del BCRP va por detrás del de SUNAT', async () => {
		const { fetchImpl } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl })

		const [bcrp, sunat] = await Promise.all([
			data.bcrpExchangeRate.lastPublishedDate(),
			data.sunatExchangeRate.lastPublishedDate(),
		])
		// BCRPData publica el interbancario con un par de días hábiles de retraso. Quien necesite
		// "el de hoy" tiene que saberlo, y por eso lastPublishedDate se lee del manifest.
		expect(bcrp! < sunat!).toBe(true)
	})
})

describe('manifest v2', () => {
	it('lo publicado es un índice y nada más', async () => {
		const wire = JSON.parse(await readFile(join(DOCS_DIR, 'manifest.json'), 'utf8'))

		expect(wire.version).toBe(MANIFEST_VERSION)
		// Los años cuelgan directo del dataset y cada uno son tres claves de una letra. Si alguna
		// vez vuelve a aparecer prosa aquí, es peso que pagan todos los visitantes en cada publish.
		const year = wire.datasets['sunat-usd-pen']['2026']
		expect(Object.keys(year).sort()).toEqual(['d', 'h', 'r'])
		expect(typeof year.d).toBe('number')
		expect(wire.datasets['sunat-usd-pen'].files).toBeUndefined()
		expect(wire.datasets['sunat-usd-pen'].title).toBeUndefined()
	})

	it('la descripción la pone el cliente y la fecha se expande del unixDay', async () => {
		const { fetchImpl } = docsFetch()
		const dataset = await createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.describe()

		expect(dataset.title).toContain('SUNAT')
		expect(dataset.hashAlgo).toBe('fnv-1a-64')
		expect(dataset.files['2026']!.lastDate).toBe('2026-09-21')
	})

	it('otra versión se rechaza en vez de leerse a medias', async () => {
		// Un manifest que esta build no entiende tiene que decirlo: leerlo como un índice vacío
		// haría que los datasets desaparecieran en silencio en vez de fallar.
		const fetchImpl = (async (url: string | URL) => {
			const path = String(url).replace('https://public-business-data.un.pe/', '')
			if (path === 'manifest.json') {
				const wire = JSON.parse(await readFile(join(DOCS_DIR, 'manifest.json'), 'utf8'))
				wire.version = MANIFEST_VERSION + 1
				return new Response(JSON.stringify(wire), { status: 200 })
			}
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		}) as unknown as typeof globalThis.fetch

		await expect(
			createPublicBusinessData({ fetch: fetchImpl }).sunatExchangeRate.availableYears(),
		).rejects.toThrow(/versión 3 y este cliente lee la 2/)
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
