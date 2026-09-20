/**
 * The caching contract: what the 20-minute window covers, what it deliberately does not, and
 * what happens when the network is gone.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { MemoryStore } from './cache'
import { createPublicBusinessData } from './index'
import { ManifestStore } from './manifest'
import { filePath } from './manifest'
import { SUNAT_USD_PEN } from './exchange-rate'

const DOCS_DIR = join(import.meta.dirname, '../../../docs')

function docsFetch(overrides: Record<string, () => Response> = {}) {
	const requested: string[] = []
	const fetchImpl = (async (url: string | URL) => {
		const path = String(url).replace('https://public-business-data.un.pe/', '')
		requested.push(path)
		const override = overrides[path]
		if (override) return override()
		try {
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		} catch {
			return new Response('not found', { status: 404 })
		}
	}) as unknown as typeof globalThis.fetch

	return { fetchImpl, requested }
}

describe('ventana de caché', () => {
	it('por defecto son 20 minutos', () => {
		expect(new ManifestStore().cacheMinutes()).toBe(20)
	})

	it('setCache(0) obliga a releer el manifest en cada llamada', async () => {
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl, cache: new MemoryStore() })
		data.setCache(0)

		await data.sunatExchangeRate.availableYears()
		await data.sunatExchangeRate.availableYears()

		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(2)
	})

	it('acortar la ventana invalida lo que ya había caducado con la nueva', async () => {
		const cache = new MemoryStore()
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl, cache, cacheMinutes: 60 })

		await data.sunatExchangeRate.availableYears()
		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(1)

		// La entrada tiene menos de 60 min pero ya más de 0: bajar la ventana la caduca ahora.
		data.setCache(0)
		await data.sunatExchangeRate.availableYears()
		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(2)
	})

	it('la ventana no se aplica a los años: van por hash y no caducan', async () => {
		const cache = new MemoryStore()
		const { fetchImpl, requested } = docsFetch()
		const data = createPublicBusinessData({ fetch: fetchImpl, cache })
		data.setCache(0)

		await data.sunatExchangeRate.at('2023-05-10')
		await data.sunatExchangeRate.at('2023-05-11')
		await data.sunatExchangeRate.at('2023-05-12')

		// El manifest se releyó tres veces; el .gz de 2023 se bajó una sola.
		expect(requested.filter((path) => path === 'manifest.json')).toHaveLength(3)
		expect(requested.filter((path) => path.endsWith('2023.gz'))).toHaveLength(1)
	})

	it('un manifest caducado se sigue usando si la red falla', async () => {
		const cache = new MemoryStore()

		const online = docsFetch()
		const first = createPublicBusinessData({ fetch: online.fetchImpl, cache })
		await first.sunatExchangeRate.at('2022-04-05')

		const offline = docsFetch({
			'manifest.json': () => {
				throw new Error('sin red')
			},
		})
		const second = createPublicBusinessData({ fetch: offline.fetchImpl, cache })
		second.setCache(0) // fuerza el intento de red, que va a fallar

		// La serie es histórica: un manifest viejo responde todo salvo "qué pasó hoy".
		const day = await second.sunatExchangeRate.at('2022-04-05')
		expect(day?.date).toBe('2022-04-05')
	})

	it('sin caché previo, una red caída sí es un error', async () => {
		const offline = docsFetch({
			'manifest.json': () => {
				throw new Error('sin red')
			},
		})
		const data = createPublicBusinessData({ fetch: offline.fetchImpl, cache: new MemoryStore() })

		await expect(data.sunatExchangeRate.latest()).rejects.toThrow(/sin red/)
	})

	it('clearCache vacía el almacén', async () => {
		const cache = new MemoryStore()
		const first = docsFetch()
		const data = createPublicBusinessData({ fetch: first.fetchImpl, cache })

		await data.sunatExchangeRate.at('2024-02-14')
		await data.clearCache()

		const second = docsFetch()
		const reloaded = createPublicBusinessData({ fetch: second.fetchImpl, cache })
		await reloaded.sunatExchangeRate.at('2024-02-14')

		expect(second.requested).toEqual(['manifest.json', 'sunat-usd-pen/2024.gz'])
	})

	it('barre los años cuyo hash el manifest ya no nombra', async () => {
		const cache = new MemoryStore()
		const first = docsFetch()
		const data = createPublicBusinessData({ fetch: first.fetchImpl, cache })
		await data.sunatExchangeRate.at('2026-09-18')

		const storedKey = new ManifestStore().fileKey(filePath(SUNAT_USD_PEN, '2026'), 'hashviejo')
		await cache.put(storedKey, new Uint8Array([1, 2, 3]))

		// Un manifest nuevo, con otro hash para 2026: la entrada vieja tiene que desaparecer.
		const changed = docsFetch({
			'manifest.json': () => {
				const manifest = JSON.parse(readFileSync())
				manifest.datasets[SUNAT_USD_PEN].files['2026'].hash = 'hashnuevo'
				return new Response(JSON.stringify(manifest), { status: 200 })
			},
		})
		const refreshed = createPublicBusinessData({ fetch: changed.fetchImpl, cache })
		refreshed.setCache(0)
		await refreshed.sunatExchangeRate.availableYears()

		expect(await cache.get(storedKey)).toBeUndefined()
	})

	it('cachea por origen, así que dos baseUrl no se pisan', async () => {
		const cache = new MemoryStore()
		const remote = new ManifestStore({ cache })
		const local = new ManifestStore({ baseUrl: 'http://localhost:8080', cache })

		expect(remote.fileKey('a/2026.gz', 'abc')).not.toBe(local.fileKey('a/2026.gz', 'abc'))
	})
})

let manifestText: string
beforeEach(async () => {
	manifestText ??= await readFile(join(DOCS_DIR, 'manifest.json'), 'utf8')
})
function readFileSync(): string {
	return manifestText
}
