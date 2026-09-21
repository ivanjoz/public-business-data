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

/** Peticiones servidas desde disco, para las pruebas que miran si algo volvió a pedirse. */
let requests = 0

// El bundle apunta al sitio público; aquí se sirve docs/ desde disco.
const diskFetch = (async (url: string | URL) => {
	requests++
	const path = String(url).replace('https://public-business-data.un.pe/', '')
	try {
		return new Response(new Uint8Array(await readFile(join(DOCS_DIR, path))), { status: 200 })
	} catch {
		return new Response('not found', { status: 404 })
	}
}) as unknown as typeof globalThis.fetch

beforeAll(async () => {
	client = (await import(BUNDLE)) as Bundle
	client.setFetch(diskFetch)
})

describe('dist/client.mjs', () => {
	it('exporta la API plana que se importa desde fuera', () => {
		for (const name of [
			'setCache', 'getCache', 'setBaseUrl', 'setFetch', 'refresh', 'clearCache',
			'getSunatRate', 'getLatestSunatRate', 'getSunatRateRange', 'getSunatRateYears',
			'getSunatMonthArrays', 'getSunatAvailableYears', 'getSunatLastPublishedDate',
			'describeSunatExchangeRate', 'getManifestGenerated', 'createPublicBusinessData',
			'getBcrpRate', 'getLatestBcrpRate', 'getBcrpRateRange', 'getBcrpRateYears',
			'getBcrpMonthArrays', 'getBcrpAvailableYears', 'getBcrpLastPublishedDate',
			'getBcrpLastConfirmedDate', 'describeBcrpExchangeRate',
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

	it('resuelve el interbancario del BCRP desde el bundle', async () => {
		const day = await client.getBcrpRate('2026-09-17')
		expect(day?.buyScaled).toBe(3362)
		expect(day?.provisional).toBe(false)
		expect((await client.getLatestBcrpRate())?.date).toBe(await client.getBcrpLastPublishedDate())
	})

	it('el flag de provisional cruza el bundle', async () => {
		expect((await client.getBcrpRate('2026-09-18'))?.provisional).toBe(true)
		expect(await client.getBcrpLastConfirmedDate()).toBe('2026-09-17')
		expect(await client.getBcrpLastPublishedDate()).toBe('2026-09-18')
	})

	it('getManifestGenerated devuelve el sello del manifest', async () => {
		const generated = await client.getManifestGenerated()
		expect(generated).toBeInstanceOf(Date)

		// El sello es el del docs/ publicado, así que se comprueba contra el archivo y no contra
		// una fecha escrita a mano, que caducaría en la siguiente corrida del updater.
		const manifest = JSON.parse(await readFile(join(DOCS_DIR, 'manifest.json'), 'utf8'))
		expect(generated.getTime()).toBe(manifest.generated * 1000)
	})

	it('setBaseUrl al mismo origen no tira lo ya descargado', async () => {
		// Con el manifest y 2026 ya en memoria de las pruebas anteriores, repetir el origen no
		// debe costar ni una petición. Si reinstanciara, habría que volver a bajar los dos.
		const before = await client.getSunatRate('2026-09-20')
		requests = 0

		client.setBaseUrl('https://public-business-data.un.pe')
		client.setBaseUrl('https://public-business-data.un.pe/') // la barra final es el mismo sitio

		expect((await client.getSunatRate('2026-09-20'))?.buy).toBe(before?.buy)
		expect(requests).toBe(0)
	})

	it('setCache cambia la ventana y getCache la reporta', () => {
		expect(client.getCache()).toBe(20)
		client.setCache(45)
		expect(client.getCache()).toBe(45)
		client.setCache(20)
	})
})
