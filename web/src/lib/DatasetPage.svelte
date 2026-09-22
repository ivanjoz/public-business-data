<script lang="ts">
  /**
   * La página de un dataset: el calendario de la serie y su documentación de integración.
   *
   * Una sola implementación para las dos series porque lo que cambia entre ellas es el nombre, la
   * nota al pie y qué funciones del cliente se llaman — todo eso viene en el registro de
   * datasets. Cada ruta monta este componente con su entrada de la tabla.
   */

  import TableGrid from '@genix/ui/vTable/TableGrid.svelte'
  import OptionsStrip from '@genix/ui/navigation/OptionsStrip.svelte'
  import type { ITableColumn } from '@genix/ui/vTable/types.ts'
  import IntegrationPanel from '$lib/IntegrationPanel.svelte'
  import { otherDatasetPage, type IDatasetPage } from '$lib/datasets'
  import {
    DEFAULT_BASE_URL,
    describeBcrpExchangeRate,
    describeSunatExchangeRate,
    setBaseUrl,
    type IExchangeRateDay,
    type IManifestDataset,
  } from '$client'
  import {
    buildCalendarRows,
    calendarMonthKeys,
    dateKeyOf,
    formatRate,
    indexRatesByDate,
    MONTHS_OFFERED,
    monthTitle,
    WEEKDAY_NAMES,
    type ICalendarRow,
    type RateKind,
  } from '$lib/calendar'

  const { dataset }: { dataset: IDatasetPage } = $props()

  /** Cuántos años pide la carga masiva. 5 = los mismos 60 meses que dibuja el calendario. */
  const YEARS_SHOWN = 5

  const TABS: [string, string][] = [
    ['muestra', 'Muestra'],
    ['integracion', 'Integración'],
  ]
  let tab = $state('muestra')

  const other = $derived(otherDatasetPage(dataset.slug))

  const calendarRows = buildCalendarRows(calendarMonthKeys(new Date(), MONTHS_OFFERED))

  let ratesByDate = $state(new Map<string, IExchangeRateDay>())
  let described = $state<IManifestDataset | undefined>()
  let loadError = $state('')
  let loading = $state(true)

  $effect(() => {
    const requested = dataset

    // Los datos están en el mismo origen que esta página, así que se piden en relativo: el sitio
    // funciona igual servido desde el dominio, desde el dev server o desde un preview local.
    setBaseUrl(location.origin)
    loading = true
    loadError = ''

    Promise.all([requested.load(YEARS_SHOWN), requested.describe()])
      .then(([days, description]) => {
        // Navegar a la otra serie mientras la anterior viaja deja dos respuestas en vuelo; sin
        // esta guarda la que llegue tarde pinta sus días bajo el nombre de la otra.
        if (dataset !== requested) return
        ratesByDate = indexRatesByDate(days)
        described = description
      })
      .catch((error: unknown) => {
        if (dataset !== requested) return
        loadError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        if (dataset === requested) loading = false
      })
  })

  const lastDateOf = (description: IManifestDataset | undefined) =>
    Object.values(description?.files ?? {}).reduce((latest, file) => {
      return file.lastDate > latest ? file.lastDate : latest
    }, '')

  const lastDate = $derived(lastDateOf(described))

  /**
   * Lo que la pestaña de integración necesita de las dos series a la vez —la nota del retraso del
   * BCRP compara los dos últimos días. Se carga una sola vez y no cuesta red: describe() sale del
   * manifest, que ya está en el caché del cliente.
   */
  let docs = $state<{ sunatLastDate: string; bcrpLastDate: string; years: string[] }>()

  $effect(() => {
    setBaseUrl(location.origin)
    Promise.all([describeSunatExchangeRate(), describeBcrpExchangeRate()])
      .then(([sunat, bcrp]) => {
        docs = {
          sunatLastDate: lastDateOf(sunat),
          bcrpLastDate: lastDateOf(bcrp),
          years: Object.keys(sunat.files).sort(),
        }
      })
      .catch(() => undefined)
  })

  const rateOfDay = (row: ICalendarRow, weekdayIndex: number, rateKind: RateKind): number => {
    const day = row.Days[weekdayIndex]
    if (!day) return 0
    return ratesByDate.get(dateKeyOf(row.MonthKey, day))?.[rateKind] ?? 0
  }

  /** Los días que no vienen de la fuente del dataset sino del relleno de referencia. */
  const isProvisional = (row: ICalendarRow, weekdayIndex: number): boolean => {
    const day = row.Days[weekdayIndex]
    if (!day) return false
    return ratesByDate.get(dateKeyOf(row.MonthKey, day))?.provisional ?? false
  }

  const provisionalDates = $derived(described?.provisional?.dates ?? [])

  // Cada día de la semana es un grupo de tres pistas: el número de día y sus dos cotizaciones.
  const rateSubcolumn = (
    weekdayIndex: number,
    rateKind: RateKind,
    header: string,
  ): ITableColumn<ICalendarRow> => ({
    id: `${rateKind}${weekdayIndex}`,
    header,
    width: 'minmax(64px, 1fr)',
    align: 'right',
    css: 'ff-mono text-[14px]',
    // Un valor de relleno no puede leerse igual que uno confirmado: se pinta en otro color, y el
    // chip de la barra dice cuántos hay y de dónde salen.
    setCellCss: (row) => (isProvisional(row, weekdayIndex) ? '_provisional' : ''),
    getValue: (row) => rateOfDay(row, weekdayIndex, rateKind),
    render: (row) => formatRate(rateOfDay(row, weekdayIndex, rateKind)),
  })

  const columns: ITableColumn<ICalendarRow>[] = WEEKDAY_NAMES.map((weekdayName, weekdayIndex) => ({
    id: `weekday${weekdayIndex}`,
    header: weekdayName,
    subcols: [
      {
        // Sin etiqueta: la columna bajo un día de la semana que lleva un número es el día.
        id: `day${weekdayIndex}`,
        header: '',
        width: '38px',
        align: 'center',
        css: 'ff-mono text-[14px] _day-cell',
        setCellCss: (row: ICalendarRow) => (row.Days[weekdayIndex] ? '_day-filled' : ''),
        getValue: (row: ICalendarRow) => row.Days[weekdayIndex] || '',
      },
      rateSubcolumn(weekdayIndex, 'buyScaled', 'Compra'),
      rateSubcolumn(weekdayIndex, 'sellScaled', 'Venta'),
    ],
  }))
</script>

<div class="page">
  <div class="head">
    <h1 class="page-title">{dataset.name}</h1>
    <!-- Envuelto en vez de reestilado: OptionsStrip lleva shrink-0, que está bien en una barra
         de escritorio y mal en una fila más estrecha que las pestañas. El envoltorio se queda
         con el ancho libre y sí puede encoger, así que el overflow-x del strip hace scroll. -->
    <div class="tabs-wrap">
      <OptionsStrip
        options={TABS}
        selected={tab}
        onSelect={(option) => (tab = option[0])}
        buttonCss="strip-button"
      />
    </div>
  </div>

  {#if tab === 'muestra'}
    <div class="toolbar">
      <div class="subtitle">Dólar a Soles, 3 decimales · últimos {YEARS_SHOWN} años</div>

      <div class="meta">
        {#if loading}
          <span class="chip">Cargando…</span>
        {:else if loadError}
          <span class="chip is-error">{loadError}</span>
        {:else}
          <span class="chip">{ratesByDate.size.toLocaleString('es-PE')} días</span>
          <span class="chip">Al {lastDate}</span>
          {#if provisionalDates.length > 0}
            <span class="chip is-provisional" title={described?.provisional?.note}>
              {provisionalDates.length}
              {provisionalDates.length === 1 ? 'día provisional' : 'días provisionales'}
            </span>
          {/if}
          <a class="chip is-link" href="/manifest.json">manifest.json</a>
        {/if}
      </div>
    </div>

    <TableGrid
      data={calendarRows}
      {columns}
      height="var(--panel-height)"
      rowHeight={30}
      getRowId={(row, rowIndex) => (row.IsMonthHeader ? `month${row.MonthKey}` : `week${rowIndex}`)}
      useRowRenderer={(row) => row.IsMonthHeader}
      {rowRenderer}
    />

    {#if described}
      <p class="source">
        Fuente: {described.source} —
        <a href={described.sourceUrl} rel="noreferrer">{described.sourceUrl}</a>.
        {dataset.note} Un día en blanco es un día sin publicación.
        {#if provisionalDates.length > 0}
          Los días <span class="_provisional-sample">en ámbar</span> ({provisionalDates.join(', ')})
          son de relleno mientras la fuente no los publica: {described?.provisional?.source}.
        {/if}
      </p>
    {/if}
  {:else}
    <!-- La documentación scrollea dentro del panel, igual que la tabla: las dos pestañas ocupan
         el mismo alto y cambiar de una a otra no mueve la página ni saca la barra del navegador. -->
    <div class="doc-scroll">
      <IntegrationPanel
        baseUrl={DEFAULT_BASE_URL}
        {dataset}
        {other}
        sunatLastDate={docs?.sunatLastDate || '2026-09-21'}
        bcrpLastDate={docs?.bcrpLastDate || '2026-09-17'}
        years={docs?.years ?? []}
      />
    </div>
  {/if}
</div>

{#snippet rowRenderer(row: ICalendarRow, _rowIndex: number)}
  <div class="_month-title ff-bold text-[15px]">{monthTitle(row.MonthKey)}</div>
{/snippet}

<style>
  .page {
    background: #fff;
    border: 1px solid #e2e4ef;
    border-radius: 8px;
    padding: 10px 12px 12px;

    /* Lo que le queda a la zona scrolleable con la cabecera, las pestañas y el pie descontados.
       Vive aquí y no en cada consumidor porque la tabla y la documentación tienen que medir lo
       mismo. TableGrid lo recibe como su prop height y lo resuelve heredado, dentro del panel. */
    --panel-height: calc(100vh - 210px);
  }

  /* El scroll es del panel, no de la ventana: el sitio entero cabe en el viewport y la barra
     del navegador no aparece nunca. El padding derecho deja sitio a la barra del contenedor
     para que no se monte sobre el texto. */
  .doc-scroll {
    max-height: var(--panel-height);
    overflow-y: auto;
    padding-right: 10px;
  }

  .head {
    display: flex;
    align-items: flex-end;
    gap: 18px;
    margin-bottom: 10px;
  }

  .page-title {
    font-size: 18px;
    font-weight: 600;
    color: #3b2e9d;
    white-space: nowrap;
    /* El strip alinea sus pestañas contra su borde inferior, así que el título baja con ellas
       en vez de quedar flotando sobre la línea de las pestañas. */
    padding-bottom: 4px;
  }

  /* flex-basis 0 con min-width 0: toma el ancho libre y aun así puede encoger por debajo de su
     contenido, que es lo que deja al overflow-x del propio strip hacer el scroll. */
  .tabs-wrap { flex: 1 1 0; min-width: 0; }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .subtitle {
    font-size: 14px;
    color: #6b6b80;
  }

  .meta {
    margin-left: auto;
    display: flex;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    background: #eeefff;
    border: 1px solid #d5d6f2;
    color: #4042a3;
    font-size: 13px;
    white-space: nowrap;
  }

  .chip.is-link { text-decoration: none; }
  .chip.is-link:hover { background: #e2e3ff; }

  .chip.is-error {
    background: #ffeded;
    border-color: #f3c2c2;
    color: #b02a2a;
  }

  /* Ámbar y no rojo: un día provisional no es un fallo, es un dato que todavía no está confirmado. */
  .chip.is-provisional {
    background: #fff6e5;
    border-color: #f0d9a8;
    color: #8a6100;
    cursor: help;
  }

  /* La cotización de relleno se lee distinta de las confirmadas sin necesidad de leyenda: el color
     y la cursiva bastan para que la vista no la sume al resto de la columna. */
  :global(._provisional) {
    color: #8a6100;
    font-style: italic;
  }

  .source {
    margin: 8px 2px 0;
    font-size: 12.5px;
    color: #74748c;
  }

  .source a { color: #4042a3; }

  ._provisional-sample {
    color: #8a6100;
    font-style: italic;
  }

  /* El mes abre sobre una línea, no sobre una banda rellena: el calendario mantiene un solo
     color de fondo y el subrayado es lo que separa un mes del anterior. */
  :global(._month-title) {
    width: 100%;
    /* Rellena la celda: la fila centra su contenido, así que un título de alto automático
       dejaría la línea flotando un par de píxeles sobre el borde, desalineada del resto. */
    height: 100%;
    display: flex;
    align-items: center;
    padding-left: 10px;
    letter-spacing: 0.04em;
    color: #4b4b6b;
    border-bottom: 2px solid #9c91df;
    border-left: 1px solid #b4b4d0;
  }

  /* El número de día abre cada grupo, así que su borde izquierdo es el separador del grupo. */
  :global(._day-cell) {
    border-left: 1px solid #b4b4d0;
  }

  /* Sólo se pintan las casillas que llevan día: las que se desbordan al mes vecino quedan en
     blanco, y eso es lo que marca dónde empieza y dónde acaba el mes. */
  :global(._day-filled) {
    background-color: #e0ddef;
    color: #2c2b37;
  }
</style>
