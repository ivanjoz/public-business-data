/**
 * The IndexedDB path, against a real IndexedDB implementation. Everywhere else the tests run in
 * Node and fall through to the memory store, so without this the feature the client is built
 * around — surviving a page reload — would never actually be exercised.
 */

import 'fake-indexeddb/auto'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { openCacheStore } from './cache'
import { createPublicBusinessData } from './index'
import { ManifestStore } from './manifest'

const DOCS_DIR = join(import.meta.dirname, '../../../docs')

function docsFetch() {
	const requested: string[] = []
	const fetchImpl = (async (url: string | URL) => {
		const path = String(url).replace('https://public-business-data.un.pe/', '')
		requested.push(path)
		try {
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		} catch {
			return new Response('not found', { status: 404 })
		}
	}) as unknown as typeof globalThis.fetch

	return { fetchImpl, requested }
}

beforeEach(async () => {
	await (await openCacheStore()).clear()
})

describe('IndexedDB', () => {
	it('se elige cuando el runtime la tiene', async () => {
		expect(typeof indexedDB).not.toBe('undefined')
		const store = await openCacheStore()
		expect(store.constructor.name).toBe('IndexedDbStore')
	})

	it('una segunda carga de la página no pide nada a la red', async () => {
		const first = docsFetch()
		const day = await createPublicBusinessData({ fetch: first.fetchImpl }).sunatExchangeRate.at('2024-06-12')
		expect(day).not.toBeNull()
		expect(first.requested).toEqual(['manifest.json', 'sunat-usd-pen/2024.gz'])

		// Instancia nueva = recarga: el estado en memoria se pierde, IndexedDB no.
		const second = docsFetch()
		const reloaded = await createPublicBusinessData({ fetch: second.fetchImpl }).sunatExchangeRate.at('2024-06-12')

		expect(reloaded).toEqual(day)
		expect(second.requested).toEqual([])
	})

	it('caducado el manifest, el año sigue saliendo de IndexedDB', async () => {
		const first = docsFetch()
		await createPublicBusinessData({ fetch: first.fetchImpl }).sunatExchangeRate.at('2023-08-08')

		const second = docsFetch()
		const data = createPublicBusinessData({ fetch: second.fetchImpl })
		data.setCache(0) // el manifest caduca siempre

		await data.sunatExchangeRate.at('2023-08-08')

		// Se vuelve a pedir el manifest, pero el .gz no: su hash no cambió.
		expect(second.requested).toEqual(['manifest.json'])
	})

	it('barre de la base los años cuyo hash ya no está en el manifest', async () => {
		const first = docsFetch()
		await createPublicBusinessData({ fetch: first.fetchImpl }).sunatExchangeRate.at('2022-03-03')

		const store = await openCacheStore()
		const staleKey = new ManifestStore().fileKey('sunat-usd-pen/2022.gz', 'hashviejo')
		await store.put(staleKey, new Uint8Array([9, 9, 9]))
		expect(await store.get(staleKey)).toBeDefined()

		const second = docsFetch()
		const data = createPublicBusinessData({ fetch: second.fetchImpl })
		data.setCache(0)
		await data.sunatExchangeRate.availableYears()

		// El barrido va en segundo plano tras adoptar el manifest.
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(await store.get(staleKey)).toBeUndefined()
	})

	it('clearCache deja la base vacía', async () => {
		const first = docsFetch()
		const data = createPublicBusinessData({ fetch: first.fetchImpl })
		await data.sunatExchangeRate.at('2021-09-15')

		await data.clearCache()

		const second = docsFetch()
		await createPublicBusinessData({ fetch: second.fetchImpl }).sunatExchangeRate.at('2021-09-15')
		expect(second.requested).toEqual(['manifest.json', 'sunat-usd-pen/2021.gz'])
	})

	it('guarda los bytes intactos, no una copia degradada', async () => {
		const store = await openCacheStore()
		const original = new Uint8Array([0x1f, 0x8b, 0x00, 0xff, 0x7f, 0x80])
		await store.put('file:prueba', original)

		const restored = (await store.get('file:prueba'))?.bytes
		expect(restored).toBeInstanceOf(Uint8Array)
		expect(Array.from(restored!)).toEqual(Array.from(original))
	})
})
