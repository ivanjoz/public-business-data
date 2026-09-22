/**
 * Los datasets publicados, uno por página.
 *
 * SUNAT y el interbancario del BCRP no son dos vistas del mismo número: SUNAT publica el cierre
 * SBS del día hábil anterior —el que pide la norma tributaria— y el BCRP el promedio del
 * interbancario, que es a lo que el mercado operó. Miden cosas distintas, se actualizan con
 * retrasos distintos y se eligen por la pregunta que uno tiene, así que cada uno es un dataset
 * con su entrada en el menú y su URL, no una pestaña dentro del otro.
 *
 * Esta tabla es lo único que sabe qué series hay: el menú, las páginas y la documentación de
 * integración salen de aquí.
 */

import {
  BCRP_INTERBANCARIO_USD_PEN,
  describeBcrpExchangeRate,
  describeSunatExchangeRate,
  getBcrpRateYears,
  getSunatRateYears,
  SUNAT_USD_PEN,
  type IExchangeRateDay,
  type IManifestDataset,
} from '$client'

export type DatasetSlug = 'sunat' | 'bcrp'

export interface IDatasetPage {
  slug: DatasetSlug
  /** La clave del dataset en el manifest, que es también su carpeta de años en el sitio. */
  key: string
  /**
   * La ruta dentro del sitio, sin el `base`. No lleva la clave del dataset
   * (`bcrp-interbancario-usd-pen`) porque esa es una carpeta de datos dentro de docs/ y una
   * página con ese nombre se la taparía.
   */
  href: string
  /** El nombre en el menú y el título de la página. */
  name: string
  /** La segunda línea del menú: qué mide, en dos palabras. */
  detail: string
  /** Para qué sirve esta serie, al pie de la muestra. */
  note: string
  /** El prefijo de su familia de funciones en el cliente: `getSunat…`, `getBcrp…`. */
  fnPrefix: string
  load: (yearsAgo: number) => Promise<IExchangeRateDay[]>
  describe: () => Promise<IManifestDataset>
}

export const DATASET_PAGES: IDatasetPage[] = [
  {
    slug: 'sunat',
    key: SUNAT_USD_PEN,
    href: '/',
    name: 'Tipo de Cambio SUNAT',
    detail: 'Oficial (SBS) · USD/PEN',
    note: 'Oficial para facturación, libros y diferencia de cambio.',
    fnPrefix: 'getSunat',
    load: getSunatRateYears,
    describe: describeSunatExchangeRate,
  },
  {
    slug: 'bcrp',
    key: BCRP_INTERBANCARIO_USD_PEN,
    href: '/bcrp-interbancario/',
    name: 'Tipo de Cambio BCRP',
    detail: 'Interbancario · USD/PEN',
    note: 'Cotización de mercado. El BCRP la publica con un par de días hábiles de retraso.',
    fnPrefix: 'getBcrp',
    load: getBcrpRateYears,
    describe: describeBcrpExchangeRate,
  },
]

export const datasetPage = (slug: DatasetSlug): IDatasetPage =>
  DATASET_PAGES.find((dataset) => dataset.slug === slug) as IDatasetPage

/** La otra serie: la documentación de cada página la enlaza en vez de explicarla. */
export const otherDatasetPage = (slug: DatasetSlug): IDatasetPage =>
  DATASET_PAGES.find((dataset) => dataset.slug !== slug) as IDatasetPage
