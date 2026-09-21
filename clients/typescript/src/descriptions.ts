/**
 * What each dataset *is*, in prose.
 *
 * This used to travel inside `manifest.json`: the same ~600 bytes per dataset, re-downloaded by
 * every visitor on every cache miss, to say something that only changes when this repository
 * changes. The manifest is an index a machine reads — hash, count, last day — so the description
 * moved here, where it costs nothing at runtime and is versioned with the code that needs it.
 *
 * A dataset the manifest names and this table does not gets a neutral description rather than an
 * error: an older bundle should still be able to list a newly published series, even if it has no
 * functions for it yet.
 */

import { RECORD_SIZE, SCALE } from './binfmt'
import { BCRP_INTERBANCARIO_USD_PEN, SUNAT_USD_PEN } from './keys'

/** The fixed half of a dataset entry — everything except which years exist. */
export interface IDatasetDescription {
	title: string
	source: string
	sourceUrl: string
	unit: string
	/** Prose, not a parsed field: enough for someone to write their own decoder. */
	record: string
	scale: number
	hashAlgo: string
}

/** Shared by every dataset published here: they all use the same binary layout. */
const FORMAT = {
	unit: 'PEN por 1 USD',
	record: `unixDay:int16, buy:int32, sell:int32 — little endian, ${RECORD_SIZE} bytes`,
	scale: SCALE,
	hashAlgo: 'fnv-1a-64',
} as const

export const DATASET_DESCRIPTIONS: Record<string, IDatasetDescription> = {
	[SUNAT_USD_PEN]: {
		...FORMAT,
		title: 'Tipo de cambio oficial SUNAT — dólar estadounidense (compra y venta)',
		source: 'SUNAT — Superintendencia Nacional de Aduanas y de Administración Tributaria (Perú)',
		sourceUrl: 'https://www.sunat.gob.pe/a/txt/tipoCambio.txt',
	},
	[BCRP_INTERBANCARIO_USD_PEN]: {
		...FORMAT,
		title: 'Tipo de cambio interbancario BCRP — dólar estadounidense (compra y venta)',
		source: 'BCRP — Banco Central de Reserva del Perú (series PD04637PD y PD04638PD)',
		sourceUrl: 'https://estadisticas.bcrp.gob.pe/estadisticas/series/api',
	},
}

/** What a provisional day is, for the dataset that has any. Same reasoning: prose, so it lives here. */
export const PROVISIONAL_DESCRIPTION = {
	source: '@fawazahmed0/currency-api vía jsDelivr — tipo de cambio de referencia',
	sourceUrl: 'https://github.com/fawazahmed0/exchange-api',
	note:
		'Días que la fuente del dataset aún no publica, rellenados con un tipo de referencia con ' +
		'un error medido de ±0,5 % contra el interbancario. No son oficiales y no sirven para ' +
		'efectos tributarios: se sobrescriben en cuanto la fuente real los publica, y se borran si ' +
		'nunca los publica.',
} as const

export function describeDataset(datasetKey: string): IDatasetDescription {
	return (
		DATASET_DESCRIPTIONS[datasetKey] ?? {
			...FORMAT,
			title: datasetKey,
			source: 'Ver https://github.com/ivanjoz/public-business-data',
			sourceUrl: 'https://github.com/ivanjoz/public-business-data',
		}
	)
}
