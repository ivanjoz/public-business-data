# public-business-data

Datos públicos de negocio publicados como archivos binarios comprimidos y estáticos en
**https://public-business-data.un.pe**. Sin API, sin servidor, sin rate limit: son archivos en
GitHub Pages con `Access-Control-Allow-Origin: *`.

Dos datasets, ambos USD/PEN, compra y venta, serie diaria desde 2021:

| dataset | qué es | para qué sirve | peso |
| --- | --- | --- | --- |
| `sunat-usd-pen` | El tipo de cambio oficial de SUNAT: el cierre SBS del día hábil anterior | Facturación, libros contables, diferencia de cambio | 9,2 KB |
| `bcrp-interbancario-usd-pen` | El interbancario del BCRP: a lo que los bancos se compran y venden dólares entre sí | Seguir el mercado, el dólar mayorista | 7,8 KB |

Los dos **casi nunca coinciden al céntimo el mismo día**, y es correcto que no lo hagan: miden
cosas distintas y SUNAT va un día por detrás del cierre SBS. Ninguno de los dos es el precio al
que se compran dólares en un banco o en una casa de cambio — ese lleva el spread del operador y
no lo publica nadie.

Diseño y decisiones: [PLAN.md](PLAN.md).

---

## Consumir el cliente

Un solo archivo `.mjs`, sin dependencias, con caché en IndexedDB incluido. Tres formas según el
proyecto:

### 1. Por URL, sin instalar nada

```html
<script type="module">
  import { getSunatRate, getLatestSunatRate } from 'https://public-business-data.un.pe/client.mjs'

  console.log(await getLatestSunatRate())        // { date: '2026-09-21', buy: 3.354, ... }
  console.log(await getSunatRate('2026-09-20'))
</script>
```

Sirve igual en Deno y en cualquier runtime que resuelva imports por HTTP.

### 2. Como dependencia (Vite, bundlers, Node)

Los bundlers no resuelven imports por HTTP, así que ahí va instalado desde el repo:

```jsonc
// package.json
"dependencies": {
  "@ivanjoz/public-business-data": "github:ivanjoz/public-business-data#main"
}
```

```ts
import { getSunatMonthArrays, setCache } from '@ivanjoz/public-business-data'
```

El paquete vive en `clients/typescript/` y trae sus `.d.ts`. Si prefieres compilar el TypeScript
con tu propio build en vez de consumir el bundle, importa el subpath `/src`:

```ts
import { getSunatRate } from '@ivanjoz/public-business-data/src'
```

### 3. Vendorizado

`docs/client.mjs` es un archivo suelto de 7,8 KB sin dependencias: copiarlo al proyecto también
es una opción válida.

---

## API

El import es estático y las funciones son `async`, porque los datos se descargan en el primer
uso. **Importar el módulo no dispara nada**: ni una petición, ni abrir IndexedDB.

Cada dataset tiene su propia familia de funciones — `getSunat…` y `getBcrp…` — porque nombran
fuentes distintas y no dos vistas del mismo número. Lo que sigue es la de SUNAT; la del BCRP es
idéntica y está [más abajo](#el-tipo-de-cambio-de-mercado-getbcrp).

```ts
import {
  getSunatRate, getLatestSunatRate, getSunatRateRange, getSunatRateYears,
  getSunatMonthArrays, getSunatAvailableYears, getSunatLastPublishedDate,
  describeSunatExchangeRate, getManifestGenerated,
  setCache, getCache, refresh, clearCache, setBaseUrl,
} from '@ivanjoz/public-business-data'

await getSunatRate('2026-09-20')
// { date: '2026-09-20', unixDay: 20716, buy: 3.354, sell: 3.362,
//   buyScaled: 3354, sellScaled: 3362, provisional: false }
// null si SUNAT no publicó ese día (feriado o fin de semana)

await getSunatRateYears(5)                       // BULK: los últimos 5 años, ~1 800 días
await getLatestSunatRate()                       // el último día publicado
await getSunatRateRange('2024-01-01', '2024-03-31')   // IExchangeRateDay[], sólo baja 2024.gz
await getSunatMonthArrays(2026, 9)               // { buy: number[31], sell: number[31] }, ×1000, 0 = sin dato
await getSunatAvailableYears()                   // ['2021', ..., '2026']
await getSunatLastPublishedDate()                // '2026-09-21', sin descargar ningún año
await getManifestGenerated()                     // Date: cuándo cambiaron los datos por última vez
await describeSunatExchangeRate()                // fuente, unidad, escala, años
```

`getSunatLastPublishedDate` y `getManifestGenerated` responden a preguntas distintas: la primera
es **hasta cuándo llegan los datos** y la segunda **cuándo se tocaron por última vez**. El sello
del manifest sólo se mueve en una publicación real — el updater escribe cuando un hash cambió,
no cuando el cron corrió — así que sigue al dato y no al reloj.

### `getSunatRateYears(yearsAgo)`

La lectura masiva: toda la serie de los últimos N años en una llamada, ordenada de más antigua a
más reciente.

```ts
const days = await getSunatRateYears(5)
days[0]        // { date: '2021-09-21', ... }
days.at(-1)    // { date: '2026-09-21', ... }
days.length    // ~1 800 días — 6 archivos, ~9 KB en total
```

Dos cosas que conviene saber:

- **La ventana termina en el último día publicado, no en el reloj de la máquina.** Así la
  respuesta es una propiedad del dato: reproducible, inmune a un reloj desfasado o a una zona
  horaria por delante de Lima, y no se pierde el día que SUNAT publica por adelantado el fin de
  semana (un `to` de "hoy" lo cortaría).
- **Son años completos, no años calendario.** `getSunatRateYears(5)` sobre una serie que termina
  el 2026-09-21 va del 2021-09-21 al 2026-09-21, o sea que toca **seis** archivos. Si pides más
  años de los que hay, empieza donde empiece la serie en vez de fallar.

Los archivos que necesita se descargan **a la vez**, no uno tras otro: cinco años en serie serían
cinco round trips para traer ocho kilobytes.

Cada día viene en las dos formas que hacen falta: `buy` decimal para mostrar y `buyScaled`
entero ×1000 para guardar. El entero es el dato publicado; el decimal es comodidad. Re-escalar a
mano al guardar es justo donde aparecen los errores de redondeo.

`getSunatMonthArrays` devuelve 31 slots con `0` donde no hay cotización — exactamente la forma y la
escala de `DetailBuyRate` / `DetailSellRate` en `finance.ExchangeRate` de genix.

### El tipo de cambio de mercado: `getBcrp…`

Las mismas ocho funciones con otro prefijo, sobre el interbancario del BCRP (series diarias
`PD04637PD` y `PD04638PD`):

```ts
import { getBcrpRate, getLatestBcrpRate, getBcrpRateYears } from '@ivanjoz/public-business-data'

await getBcrpRate('2026-09-17')
// { date: '2026-09-17', buy: 3.362, sell: 3.364, buyScaled: 3362, sellScaled: 3364 }
// null si el mercado no operó ese día

await getBcrpRateYears(5)              // BULK, igual que el de SUNAT
await getBcrpLastPublishedDate()       // '2026-09-17'
```

Dos cosas que hay que saber antes de usarlo:

- **El BCRP lo publica con un par de días hábiles de retraso**, así que su último día va por
  detrás del de SUNAT. No hay "el interbancario de hoy" en ninguna API pública del Estado; lo más
  reciente que existe es el oficial de SUNAT, que es el cierre SBS del día hábil anterior.
- **No sirve para efectos tributarios.** Para IGV, libros y diferencia de cambio la norma apunta
  a SUNAT/SBS, no al interbancario.

El interbancario sólo existe los días en que el mercado operó: unos 250 al año, sin fines de
semana ni feriados.

### Días provisionales

Para que la cola de la serie no quede vacía durante ese retraso, **los últimos hasta 3 días
hábiles que el BCRP aún no publica se rellenan** con un tipo de referencia
(`@fawazahmed0/currency-api`), y llegan marcados:

```ts
const day = await getBcrpRate('2026-09-18')
day?.provisional      // true → es relleno, no es el interbancario

const { buy, provisional } = await getBcrpMonthArrays(2026, 9)
provisional[17]       // true si el día 18 es de relleno

await getBcrpLastPublishedDate()   // '2026-09-18' — hasta dónde llega la serie
await getBcrpLastConfirmedDate()   // '2026-09-17' — hasta dónde llega el dato del BCRP

;(await describeBcrpExchangeRate()).provisional
// { source, sourceUrl, note, dates: ['2026-09-18'] }
```

Las reglas, que son lo que hace el mecanismo seguro:

| regla | qué significa |
| --- | --- |
| El BCRP siempre gana | Cuando publica el día, su valor sobrescribe al de relleno y el flag desaparece |
| Máximo 3 días hábiles | Nunca se rellena más atrás, ni un sábado ni un domingo |
| Caducan | Un día que el BCRP nunca confirma — un feriado peruano — se **borra** al salir de la ventana, en vez de quedarse en la serie para siempre |

Es decir: **todo día más viejo que esos 3 días hábiles viene del BCRP y de nadie más.**

Un valor provisional tiene un error medido de **±0,5 % (±1,5 céntimos)** contra el interbancario,
y `buy`/`sell` se reparten alrededor del valor de referencia usando el spread mediano de los días
reales — la fuente cotiza un solo número. **No lo uses para facturar, para libros ni para una
liquidación.** El flag existe para eso; comprobarlo cuesta una propiedad.

Para varias instancias o un origen distinto, está la clase:

```ts
import { createPublicBusinessData } from '@ivanjoz/public-business-data'
const data = createPublicBusinessData({ baseUrl: 'http://localhost:8080', cacheMinutes: 5 })
await data.sunatExchangeRate.latest()
await data.bcrpExchangeRate.latest()
```

Las dos series comparten el `ManifestStore`, así que una página que muestre ambas pide el
`manifest.json` una sola vez y baja sólo los años que abra de cada una.

---

## Caché

```ts
setCache(20)      // minutos antes de volver a mirar el manifest. Por defecto: 20
setCache(0)       // no reutilizar: comprobar siempre
getCache()        // los minutos configurados
refresh()         // ignora la ventana en la próxima llamada
await clearCache()// vacía IndexedDB
```

Todo se guarda en una base IndexedDB llamada `public-business-data`, y **la ventana se aplica al
manifest, no a los datos**:

| qué | cómo se cachea |
| --- | --- |
| `manifest.json` | por tiempo — la ventana de `setCache(minutes)` |
| un año (`2024.gz`) | por el hash que el manifest le da: **inmutable, nunca caduca** |

Un año publicado no cambia, así que `2021.gz` no tiene ningún motivo para volver a bajarse nunca.
Lo que descubre que algo cambió es releer el manifest; cuando un año cambia, cambia su hash,
cambia la clave del caché, y sólo ese año se vuelve a pedir. Los años cuyo hash ya no aparece en
el manifest se barren solos.

Ponerle un reloj a los datos en vez de al manifest re-descargaría toda la historia cada 20
minutos para averiguar que nada se movió.

Dos detalles más: si no hay IndexedDB (Node, SSR, una ventana privada que la deniega) el caché
cae a memoria y todo sigue funcionando; y si la red falla pero hay un manifest guardado aunque
esté caducado, **se usa el caducado** — la serie es histórica y responde todo salvo "qué pasó
hoy".

---

## Los datos directamente

Si no quieres el cliente, son dos `curl`:

```bash
curl https://public-business-data.un.pe/manifest.json
curl -s https://public-business-data.un.pe/sunat-usd-pen/2026.gz | gunzip | xxd | head
curl -s https://public-business-data.un.pe/bcrp-interbancario-usd-pen/2026.gz | gunzip | xxd | head
```

Los dos datasets comparten formato: cada registro son **10 bytes, little endian**
(`unixDay:int16, buy:int32, sell:int32`), con las cotizaciones ×1000 y ordenados ascendentemente
por día. `unixDay` es días desde 1970-01-01. Un día ausente significa que la fuente no publicó.

El `manifest.json` es un índice y nada más — no se autodescribe, porque esa descripción serían los
mismos bytes redescargados por cada visitante en cada publicación para decir algo que sólo cambia
cuando cambia este repositorio:

```jsonc
{
  "version": 2,
  "generated": 1789948262,                       // unix; última vez que los datos se movieron
  "datasets": {
    "sunat-usd-pen": {
      "2026": {"h":"7da90ae37e84eae0","r":264,"d":20717}
    }
  },
  "provisional": {                               // ausente cuando no hay ningún día de relleno
    "bcrp-interbancario-usd-pen": [20714]
  }
}
```

| clave | qué es |
| --- | --- |
| `h` | hash FNV-1a-64 del payload **descomprimido**, en hexadecimal |
| `r` | cuántos días trae el archivo |
| `d` | el último día que cubre, como `unixDay` |
| `provisional` | por dataset, los `unixDay` que no vienen de su propia fuente |

La ruta no está porque es `{dataset}/{año}.gz`. `version` sube cuando el formato cambia: si no es
la que tu código entiende, falla en vez de leerlo a medias. El cliente de TypeScript vuelve a
pegar la descripción (`title`, `unit`, `scale`, `record`) al expandirlo, así que `describe()` sigue
devolviéndola.

> GitHub Pages sirve los `.gz` como `Content-Type: application/gzip` **sin**
> `Content-Encoding: gzip`, así que el navegador entrega bytes gzip en crudo y hay que
> descomprimirlos a mano (`DecompressionStream('gzip')`). El cliente ya lo hace.

---

## Desarrollo

```bash
node start.js           # web + tests del cliente + tests del updater, en una sola consola

./deploy.sh dry-run       # qué publicaría el updater, sin commitear
./deploy.sh backfill      # regenera la serie de SUNAT desde data/ con el codificador actual
./deploy.sh backfill-bcrp # regenera la serie del BCRP pidiéndosela a su API
./deploy.sh               # compila el updater a arm64 y despliega el stack

cd updater && go test ./...
cd clients/typescript && bun install && bun run test && bun run build
cd web && bun run check && bun run build
```

`bun run build` en `clients/typescript` regenera `docs/client.mjs`: hay que ejecutarlo y commitear
el resultado cuando se toca `src/`.

`bun run build` en `web` deja `index.html` y `_app/` en `docs/`, que es lo único que el sitio posee
ahí — el resto de `docs/` son los datos. Empieza borrando esas dos rutas porque `docs/` es a la vez
la salida y la carpeta de assets estáticos del dev server: sin limpiarla, vite copiaría el `_app`
de la publicación anterior dentro del nuevo build y cada build arrastraría un juego de chunks más.
