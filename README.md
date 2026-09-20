# public-business-data

Datos públicos de negocio publicados como archivos binarios comprimidos y estáticos en
**https://public-business-data.un.pe**. Sin API, sin servidor, sin rate limit: son archivos en
GitHub Pages con `Access-Control-Allow-Origin: *`.

Dataset actual: **tipo de cambio oficial SUNAT USD/PEN**, compra y venta, serie diaria desde
2021. Seis años completos pesan **9,2 KB**.

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

```ts
import {
  getSunatRate, getLatestSunatRate, getSunatRateRange, getSunatRateYears,
  getSunatMonthArrays, getSunatAvailableYears, getSunatLastPublishedDate,
  describeSunatExchangeRate, getManifestGenerated,
  setCache, getCache, refresh, clearCache, setBaseUrl,
} from '@ivanjoz/public-business-data'

await getSunatRate('2026-09-20')
// { date: '2026-09-20', unixDay: 20716, buy: 3.354, sell: 3.362, buyScaled: 3354, sellScaled: 3362 }
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

Para varias instancias o un origen distinto, está la clase:

```ts
import { createPublicBusinessData } from '@ivanjoz/public-business-data'
const data = createPublicBusinessData({ baseUrl: 'http://localhost:8080', cacheMinutes: 5 })
await data.sunatExchangeRate.latest()
```

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

Si no quieres el cliente, el formato está documentado en el propio manifest:

```bash
curl https://public-business-data.un.pe/manifest.json
curl -s https://public-business-data.un.pe/sunat-usd-pen/2026.gz | gunzip | xxd | head
```

Cada registro son **10 bytes, little endian**: `unixDay:int16, buy:int32, sell:int32`, con las
cotizaciones ×1000 y ordenados ascendentemente por día. Un día ausente significa que SUNAT no
publicó.

> GitHub Pages sirve los `.gz` como `Content-Type: application/gzip` **sin**
> `Content-Encoding: gzip`, así que el navegador entrega bytes gzip en crudo y hay que
> descomprimirlos a mano (`DecompressionStream('gzip')`). El cliente ya lo hace.

---

## Desarrollo

```bash
node start.js           # web + tests del cliente + tests del updater, en una sola consola

./deploy.sh dry-run     # qué publicaría el updater, sin commitear
./deploy.sh backfill    # regenera docs/ desde data/ con el codificador actual
./deploy.sh             # compila el updater a arm64 y despliega el stack

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
