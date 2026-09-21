<script lang="ts">
  /**
   * La pestaña "Integración": cómo consumir el dataset desde otro proyecto.
   *
   * Vive aparte de +page.svelte porque no comparte nada con la tabla: la muestra dibuja datos y
   * esto es documentación. Los pocos valores que sí salen del dato — el origen, el último día —
   * llegan por props para que la página no tenga que duplicar la consulta al manifest.
   */

  interface Props {
    /**
     * La URL pública del sitio, no el origen desde el que se sirve esta página: los ejemplos se
     * copian y se pegan en otro proyecto, así que en el dev server tienen que seguir apuntando
     * al dominio y no a localhost. Llega desde DEFAULT_BASE_URL, que es la del propio cliente.
     */
    baseUrl: string
    /** Último día de la serie de SUNAT. */
    lastDate: string
    /** Último día del interbancario, que va por detrás: el BCRP lo publica con retraso. */
    bcrpLastDate: string
    years: string[]
  }

  const { baseUrl, lastDate, bcrpLastDate, years }: Props = $props()

  const firstYear = $derived(years[0] ?? '2021')

  let copiedBlock = $state('')

  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text)
    copiedBlock = id
    setTimeout(() => { if (copiedBlock === id) copiedBlock = '' }, 1400)
  }
</script>

{#snippet code(id: string, language: string, source: string)}
  <div class="code">
    <div class="code-bar">
      <span class="code-lang">{language}</span>
      <button class="code-copy" onclick={() => copy(id, source)}>
        {copiedBlock === id ? 'copiado' : 'copiar'}
      </button>
    </div><pre>{source}</pre>
  </div>
{/snippet}

<div class="doc">
  <p class="lead">
    El cliente es un solo archivo <code>.mjs</code> sin dependencias, con caché en IndexedDB
    incluido. Se importa de forma estática y sus funciones son <code>async</code>: los datos se
    descargan en el primer uso, no al importar.
  </p>

  <p>
    Se publican <strong>dos series</strong>, cada una con su familia de funciones. No son dos
    vistas del mismo número: miden cosas distintas y casi nunca coinciden al céntimo el mismo día.
  </p>

  <table class="doc-table">
    <thead>
      <tr><th>para</th><th>qué usar</th><th>funciones</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>Facturación, libros contables, diferencia de cambio</td>
        <td>SUNAT — el cierre SBS del día hábil anterior</td>
        <td><code>getSunat…</code></td>
      </tr>
      <tr>
        <td>Seguir el mercado, el dólar mayorista</td>
        <td>BCRP — el interbancario, a lo que operaron los bancos</td>
        <td><code>getBcrp…</code></td>
      </tr>
      <tr>
        <td>Comprar o vender dólares de verdad</td>
        <td colspan="2">Ninguna de las dos: es el precio del banco o de la casa de cambio, con su
        spread, y no lo publica nadie</td>
      </tr>
    </tbody>
  </table>

  <h2>1 · Importar</h2>

  <h3>Por URL, sin instalar nada</h3>
  <p>El cliente se publica junto a los datos, así que un navegador o Deno lo importa directo.</p>
  {@render code(
    'url',
    'html',
    `<script type="module">
  import { getSunatRate, getSunatRateYears } from '${baseUrl}/client.mjs'

  console.log(await getSunatRate('${lastDate}'))
  console.log(await getSunatRateYears(5))
<\/script>`,
  )}

  <h3>Con un bundler (Vite, SvelteKit, Node)</h3>
  <p>
    Los bundlers no resuelven imports por HTTP, así que ahí va instalado desde el repositorio.
    El paquete trae sus <code>.d.ts</code>.
  </p>
  {@render code(
    'npm',
    'package.json',
    `"dependencies": {
  "@ivanjoz/public-business-data": "github:ivanjoz/public-business-data#main"
}`,
  )}
  {@render code('npm-use', 'ts', `import { getSunatRateYears } from '@ivanjoz/public-business-data'`)}

  <h2>2 · Leer el tipo de cambio oficial (SUNAT)</h2>

  {@render code(
    'api',
    'ts',
    `await getSunatRate('${lastDate}')
// { date: '${lastDate}', unixDay: 20717, buy: 3.354, sell: 3.362,
//   buyScaled: 3354, sellScaled: 3362 }
// null si SUNAT no publicó ese día — feriado o fin de semana

await getSunatRateYears(5)              // BULK: los últimos 5 años, ~1 800 días
await getSunatRateRange('${firstYear}-01-01', '${lastDate}')
await getLatestSunatRate()              // el último día publicado
await getSunatMonthArrays(2026, 9)      // { buy: number[31], sell: number[31] }
await getSunatAvailableYears()          // ${JSON.stringify(years)}
await getSunatLastPublishedDate()       // '${lastDate}', sin descargar ningún año
await getManifestGenerated()            // Date: cuándo cambiaron los datos por última vez
await describeSunatExchangeRate()       // fuente, unidad, escala, años`,
  )}

  <p>
    Cada día llega en las dos formas que hacen falta: <code>buy</code> decimal para mostrar y
    <code>buyScaled</code> entero ×1000 para guardar. El entero es el dato publicado; el decimal
    es comodidad. Re-escalar a mano al guardar es justo donde aparecen los errores de redondeo.
  </p>

  <div class="callout">
    <strong>getSunatRateYears</strong> ancla la ventana en el último día publicado, no en el reloj
    de la máquina: la respuesta es reproducible y no se pierde el día que SUNAT publica por
    adelantado el fin de semana. Son años completos, no años calendario, así que 5 años sobre una
    serie que acaba el {lastDate} cruza seis archivos. Los descarga en paralelo.
  </div>

  <h2>3 · Leer el tipo de cambio de mercado (BCRP)</h2>

  <p>
    Las mismas funciones con otro prefijo, sobre las series diarias
    <code>PD04637PD</code> y <code>PD04638PD</code> del BCRP: el interbancario, que es el precio al
    que los bancos se compran y venden dólares entre sí.
  </p>

  {@render code(
    'bcrp',
    'ts',
    `await getBcrpRate('${bcrpLastDate}')
// { date: '${bcrpLastDate}', buy: 3.362, sell: 3.364, buyScaled: 3362, sellScaled: 3364 }
// null si el mercado no operó ese día

await getBcrpRateYears(5)               // BULK: los últimos 5 años
await getBcrpRateRange('${firstYear}-01-01', '${bcrpLastDate}')
await getLatestBcrpRate()
await getBcrpMonthArrays(2026, 9)
await getBcrpAvailableYears()
await getBcrpLastPublishedDate()        // '${bcrpLastDate}', contando los provisionales
await getBcrpLastConfirmedDate()        // hasta dónde llega el dato confirmado
await describeBcrpExchangeRate()`,
  )}

  <div class="callout">
    El BCRP publica el interbancario con <strong>un par de días hábiles de retraso</strong>, así
    que su último día va por detrás del de SUNAT ({bcrpLastDate} frente a {lastDate} ahora mismo).
    Para «el de hoy» no hay dato oficial: el que sí existe es el de SUNAT, que es el cierre SBS del
    día hábil anterior.
  </div>

  <h3>Días provisionales</h3>

  <p>
    Para que la cola de la serie no quede vacía, <strong>los últimos hasta 3 días hábiles que el
    BCRP aún no publica se rellenan</strong> con un tipo de referencia
    (<code>@fawazahmed0/currency-api</code>), y llegan marcados:
  </p>

  {@render code(
    'provisional',
    'ts',
    `const day = await getBcrpRate('${bcrpLastDate}')
if (day?.provisional) {
  // Valor de relleno: error medido de ±0,5 % contra el interbancario.
  // No sirve para facturar ni para libros. Se sobrescribe con el valor
  // del BCRP en cuanto lo publica, y se borra si nunca lo publica.
}

const { buy, provisional } = await getBcrpMonthArrays(2026, 9)
provisional[17]                         // true si el día 18 es de relleno

;(await describeBcrpExchangeRate()).provisional
// { source, sourceUrl, note, dates: ['${bcrpLastDate}'] }`,
  )}

  <table class="doc-table">
    <thead>
      <tr><th>regla</th><th>qué significa</th></tr>
    </thead>
    <tbody>
      <tr>
        <td>El BCRP siempre gana</td>
        <td>Cuando publica el día, su valor sobrescribe al de relleno y el flag desaparece</td>
      </tr>
      <tr>
        <td>Máximo 3 días hábiles</td>
        <td>Nunca se rellena más atrás, ni un sábado ni un domingo</td>
      </tr>
      <tr>
        <td>Caducan</td>
        <td>Un día que el BCRP nunca confirma — un feriado peruano — se <strong>borra</strong> al
        salir de la ventana, en vez de quedarse en la serie para siempre</td>
      </tr>
    </tbody>
  </table>

  <p>
    O sea que <strong>todo día más viejo que esos 3 días hábiles viene del BCRP y de nadie más</strong>.
    El flag vive en el <code>manifest.json</code> y no en los registros: son un puñado de fechas, y
    un byte por registro costaría el 10 % de cada archivo para siempre y rompería los decodificadores
    ya escritos contra el formato de 10 bytes.
  </p>

  <h2>4 · Caché</h2>

  {@render code(
    'cache',
    'ts',
    `setCache(20)        // minutos antes de volver a mirar el manifest. Por defecto: 20
setCache(0)         // no reutilizar: comprobar siempre
getCache()          // los minutos configurados
refresh()           // ignora la ventana en la próxima llamada
await clearCache()  // vacía IndexedDB`,
  )}

  <p>
    Todo se guarda en una base IndexedDB llamada <code>public-business-data</code>, y la ventana
    se aplica al manifest, no a los datos:
  </p>

  <table class="doc-table">
    <thead>
      <tr><th>qué</th><th>cómo se cachea</th></tr>
    </thead>
    <tbody>
      <tr>
        <td><code>manifest.json</code></td>
        <td>por tiempo — la ventana de <code>setCache(minutes)</code></td>
      </tr>
      <tr>
        <td>un año (<code>2024.gz</code>)</td>
        <td>por el hash que el manifest le da: <strong>inmutable, nunca caduca</strong></td>
      </tr>
    </tbody>
  </table>

  <p>
    Un año publicado no cambia, así que <code>{firstYear}.gz</code> no tiene motivo para volver a
    bajarse nunca. Releer el manifest es lo que descubre que algo cambió; cuando un año cambia,
    cambia su hash, cambia la clave del caché, y sólo ese año se vuelve a pedir. Los años cuyo
    hash ya no aparece se barren solos. Ponerle un reloj a los datos re-descargaría toda la
    historia cada 20 minutos para averiguar que nada se movió.
  </p>

  <p>
    Sin IndexedDB —Node, SSR, una ventana privada que la deniega— el caché cae a memoria y todo
    sigue funcionando. Y si la red falla pero hay un manifest guardado aunque esté caducado, se
    usa el caducado: la serie es histórica y responde todo salvo «qué pasó hoy».
  </p>

  <h2>5 · Sin el cliente</h2>

  <p>Son archivos estáticos con <code>Access-Control-Allow-Origin: *</code>. El propio manifest documenta el formato.</p>

  {@render code(
    'raw',
    'bash',
    `curl ${baseUrl}/manifest.json
curl -s ${baseUrl}/sunat-usd-pen/2026.gz | gunzip | xxd | head
curl -s ${baseUrl}/bcrp-interbancario-usd-pen/2026.gz | gunzip | xxd | head`,
  )}

  <p>Cada registro son <strong>10 bytes, little endian</strong>, ordenados ascendentemente por día:</p>

  <table class="doc-table">
    <thead>
      <tr><th>offset</th><th>campo</th><th>tipo</th><th>significado</th></tr>
    </thead>
    <tbody>
      <tr><td>0</td><td><code>unixDay</code></td><td><code>int16</code></td><td>días desde el unix epoch</td></tr>
      <tr><td>2</td><td><code>buy</code></td><td><code>int32</code></td><td>compra × 1000</td></tr>
      <tr><td>6</td><td><code>sell</code></td><td><code>int32</code></td><td>venta × 1000</td></tr>
    </tbody>
  </table>

  <div class="callout">
    GitHub Pages sirve los <code>.gz</code> como <code>Content-Type: application/gzip</code>
    <strong>sin</strong> <code>Content-Encoding: gzip</code>, así que el navegador entrega bytes
    gzip en crudo y hay que descomprimirlos a mano con
    <code>DecompressionStream('gzip')</code>. El cliente ya lo hace.
  </div>

  <p class="foot">
    Un día ausente significa que la fuente no publicó, y la cobertura no es un registro por fecha
    calendario: SUNAT rellena fines de semana en los años recientes y no en los antiguos, y el
    interbancario sólo existe los días en que el mercado operó — unos 250 al año.
  </p>
</div>

<style>
  .doc {
    max-width: 860px;
    padding: 4px 2px 12px;
    font-size: 14.5px;
    line-height: 1.6;
    color: #3a3a46;
  }

  .lead { margin: 0 0 4px; }

  .doc h2 {
    font-size: 15px;
    font-weight: 600;
    color: #3b2e9d;
    margin: 26px 0 8px;
    padding-bottom: 5px;
    border-bottom: 1px solid #e2e4ef;
  }

  .doc h3 {
    font-size: 14px;
    font-weight: 600;
    color: #4b4b6b;
    margin: 16px 0 4px;
  }

  .doc p { margin: 8px 0; }

  .doc code {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    background: #f1f2fa;
    border-radius: 4px;
    padding: 1px 5px;
  }

  .code {
    margin: 8px 0 12px;
    border: 1px solid #dcdeee;
    border-radius: 7px;
    overflow: hidden;
    background: #fbfbff;
  }

  .code-bar {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0 8px 0 10px;
    background: #f1f2fa;
    border-bottom: 1px solid #e4e6f4;
  }

  .code-lang {
    font-size: 11.5px;
    letter-spacing: 0.05em;
    color: #8b8ba7;
    text-transform: uppercase;
  }

  .code-copy {
    margin-left: auto;
    border: 1px solid #d5d6f2;
    background: #fff;
    color: #4042a3;
    border-radius: 5px;
    font-size: 12px;
    padding: 2px 9px;
    cursor: pointer;
  }

  .code-copy:hover { background: #eeefff; }

  .code pre {
    margin: 0;
    padding: 10px 12px;
    overflow-x: auto;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12.8px;
    line-height: 1.55;
    color: #2f2f45;
  }

  .doc-table {
    border-collapse: collapse;
    margin: 8px 0 12px;
    font-size: 13.5px;
  }

  .doc-table th,
  .doc-table td {
    border: 1px solid #e2e4ef;
    padding: 5px 12px;
    text-align: left;
  }

  .doc-table th {
    background: #f6f7fc;
    font-weight: 600;
    color: #4b4b6b;
  }

  .callout {
    margin: 10px 0 12px;
    padding: 9px 12px;
    background: #f6f7fc;
    border-left: 3px solid #9c91df;
    border-radius: 0 6px 6px 0;
    font-size: 13.8px;
  }

  .foot {
    margin-top: 18px;
    font-size: 13px;
    color: #74748c;
  }
</style>
