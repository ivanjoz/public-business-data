/**
 * Exercises dist/client.mjs — the file other projects actually import — instead of the source.
 * A bundle that drops an export or breaks the lazy singleton would still pass every other test
 * in here, so this is the one that has to load the built artifact.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const DOCS_DIR = join(import.meta.dirname, '../../../docs')
const BUNDLE = join(import.meta.dirname, '../dist/client.mjs')

type Bundle = typeof import('./index')

let client: Bundle

beforeAll(async () => {
	client = (await import(BUNDLE)) as Bundle

	// El bundle apunta al sitio público; aquí se sirve docs/ desde disco.
	client.setFetch((async (url: string | URL) => {
		const path = String(url).replace('https://public-business-data.un.pe/', '')
		try {
			return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
		} catch {
			return new Response('not found', { status: 404 })
		}
	}) as unknown as typeof globalThis.fetch)
})

describe('dist/client.mjs', () => {
	it('exporta la API plana que se importa desde fuera', () => {
		for (const name of [
			'setCache', 'getCache', 'setBaseUrl', 'setFetch', 'refresh', 'clearCache',
			'getSunatRate', 'getLatestSunatRate', 'getSunatRateRange', 'getSunatRateYears',
			'getSunatMonthArrays', 'getSunatAvailableYears', 'getSunatLastPublishedDate',
			'describeSunatExchangeRate', 'createPublicBusinessData',
		] as const) {
			expect(typeof client[name], name).toBe('function')
		}
	})

	it('importar el módulo no dispara ninguna petición', async () => {
		let calls = 0
		const fresh = (await import(`${BUNDLE}?probe`)) as Bundle
		fresh.setFetch((async () => {
			calls++
			return new Response('', { status: 404 })
		}) as unknown as typeof globalThis.fetch)

		// Nada de red hasta que se llama a algo: el import es gratis.
		expect(calls).toBe(0)
	})

	it('resuelve un tipo de cambio de punta a punta', async () => {
		const day = await client.getSunatRate('2026-09-20')
		expect(day?.buy).toBe(3.354)
		expect(day?.sellScaled).toBe(3362)
	})

	it('getLatestSunatRate y getSunatRateRange funcionan desde el bundle', async () => {
		expect((await client.getLatestSunatRate())?.date).toBe('2026-09-21')
		expect(await client.getSunatRateRange('2025-01-02', '2025-01-03')).toHaveLength(2)
	})

	it('getSunatMonthArrays entrega los 31 slots escalados', async () => {
		const { buy, sell } = await client.getSunatMonthArrays(2026, 9)
		expect(buy).toHaveLength(31)
		expect(buy[19]).toBe(3354)
		expect(sell[19]).toBe(3362)
	})

	it('getSunatRateYears trae la serie completa desde el bundle', async () => {
		const days = await client.getSunatRateYears(5)
		expect(days[0]?.date).toBe('2021-09-21')
		expect(days.at(-1)?.date).toBe('2026-09-21')
	})

	it('setCache cambia la ventana y getCache la reporta', () => {
		expect(client.getCache()).toBe(20)
		client.setCache(45)
		expect(client.getCache()).toBe(45)
		client.setCache(20)
	})
})
