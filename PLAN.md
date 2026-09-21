# PLAN — public-business-data

Repositorio de datos públicos de negocio, publicados como archivos binarios comprimidos y
estáticos en GitHub Pages (`https://public-business-data.un.pe`), mantenidos por una lambda en Go
que sólo hace commit cuando el dato realmente cambió.

Datasets: **tipo de cambio oficial SUNAT USD/PEN** y **tipo de cambio interbancario BCRP USD/PEN**,
los dos con compra y venta. El primero es el valor contable que pide la norma tributaria; el
segundo es la cotización de mercado. Ver §11.

---

## 1. Estado actual

Ya hecho en esta sesión:

- `data/tipo-cambio-sunat-usd-pen.json` — snapshot de 1 976 días (2021-01-01 → 2026-09-21),
  contrastado contra el archivo oficial `https://www.sunat.gob.pe/a/txt/tipoCambio.txt`.
- `updater/binfmt/` — el codificador binario + gzip + hash FNV, con tests.
- `updater/manifest/` — el archivo maestro de hashes.
- `updater/cmd/backfill/` — siembra `docs/` desde el snapshot.
- `docs/` — los 6 `.gz` iniciales + `manifest.json` + `CNAME` + `.nojekyll`.
  **9,2 KB en total para 6 años de serie diaria.**

Verificado leyendo los `.gz` desde JavaScript con `DecompressionStream` + `DataView`:
1 976/1 976 registros coinciden con la fuente, 0 discrepancias.

Falta: la lambda, el cliente TypeScript, la configuración de Pages y el DNS.

---

## 2. Formato binario

Un archivo por año y por dataset. El payload es un array plano de registros de **10 bytes**,
**little endian**, **ordenado ascendentemente por día**:

| offset | campo     | tipo    | significado                                         |
| -----: | --------- | ------- | --------------------------------------------------- |
|      0 | `unixDay` | `int16` | días desde el unix epoch (1970-01-01)                |
|      2 | `buy`     | `int32` | compra × 1000                                        |
|      6 | `sell`    | `int32` | venta × 1000                                         |

Decisiones y sus límites:

- **`unixDay` como `int16`** es la convención de genix (`AGENTS.md` §9: *"Save dates as UnixDay
  int16"*), así que un valor cruza sin conversión. Techo: **32767 = 2059-09-18**. `binfmt.Encode`
  lo documenta; no hace falta hacer nada hasta entonces.
- **Escala 1000** = los mismos 3 decimales que publica SUNAT, y exactamente el
  `EXCHANGE_RATE_SCALE = 1000` que el frontend de genix ya usa para almacenar cotizaciones.
- **Sin padding.** 10 bytes desalinea los `int32`, pero tanto `DataView` como `encoding/binary`
  leen desalineado sin coste real; alinear costaría 20% de cada archivo a cambio de nada.
- **Orden ascendente es parte del contrato**, no una casualidad: el cliente hace búsqueda binaria
  sobre el buffer en vez de construir un `Map`. Un archivo desordenado respondería mal en silencio,
  por eso `Encode` ordena siempre y rechaza días duplicados.
- **Un día ausente significa "SUNAT no publicó"** (feriado, o fin de semana en los años en que la
  fuente no rellena). No existe el registro con ceros.

Un año completo son ~3,6 KB en crudo y ~1,6 KB comprimido.

### Por qué el hash es del payload sin comprimir

`binfmt.Hash` es **FNV-1a de 64 bits en hex** sobre los bytes **antes** de gzip. Si se hasheara el
`.gz`, la pregunta "¿cambió el dato?" sólo sería contestable desde la misma versión exacta del
compresor. Hasheando el payload, el hash describe el dato y nada más — y sirve igual al cliente
como clave de caché.

Aparte, `binfmt.Gzip` escribe el header con `ModTime` y `Name` vacíos, de forma que el mismo dato
produce siempre los mismos bytes y un año sin cambios nunca aparece como diff.

---

## 3. `docs/` — lo que se publica

```
docs/
├── CNAME                                 public-business-data.un.pe
├── .nojekyll                             Pages copia los archivos, no corre Jekyll
├── index.html                            landing: qué hay aquí y cómo se lee   [pendiente]
├── manifest.json                         archivo maestro de hashes
├── sunat-usd-pen/
│   ├── 2021.gz  2022.gz  2023.gz  2024.gz  2025.gz  2026.gz
└── bcrp-interbancario-usd-pen/
    ├── 2021.gz  2022.gz  2023.gz  2024.gz  2025.gz  2026.gz
```

`manifest.json` es a la vez el detector de cambios de la lambda y el punto de entrada del cliente:

```jsonc
{
  "version": 2,
  "generated": 1789948262,                       // unix; se mueve en cada publicación
  "datasets": {
    "bcrp-interbancario-usd-pen": {
      "2025": {"h":"843d4f53f5904c4c","r":248,"d":20453},
      "2026": {"h":"4c984be6f7415b22","r":176,"d":20714}
    },
    "sunat-usd-pen": {
      "2026": {"h":"7da90ae37e84eae0","r":264,"d":20717}
    }
  },
  "provisional": {                               // ausente cuando no hay ningún día de relleno
    "bcrp-interbancario-usd-pen": [20714]
  }
}
```

Es un índice, no un documento. Tiene exactamente dos trabajos — *"¿cambió el año Y?"* para la
lambda y *"¿qué años hay y sigue vigente mi caché?"* para el cliente — y los dos se responden con
tres valores por año:

| clave | qué es |
| --- | --- |
| `h` | hash FNV-1a-64 del payload **sin comprimir**; lo único que la lambda compara |
| `r` | cantidad de días — cuánto hay, sin descargar el archivo |
| `d` | último día, como `unixDay` — hasta cuándo llega, sin descargar el archivo |

La ruta no se guarda: es `{clave del dataset}/{año}.gz`, donde la clave del dataset **es** la
carpeta y la del año **es** el archivo.

**v2 sacó la prosa.** `title`, `source`, `sourceUrl`, `unit`, `record`, `scale` y `hashAlgo` eran
los mismos ~600 bytes por dataset en cada publicación, redescargados por cada visitante en cada
fallo de caché, para decir algo que sólo cambia cuando cambia este repositorio. Ahora viven en
`clients/typescript/src/descriptions.ts` y el cliente los vuelve a pegar al expandir el manifest,
así que la API pública no cambió: `describeSunatExchangeRate()` sigue devolviendo `title`, `unit`
y `scale`. Quien lea el `.json` en crudo sin este cliente necesita esa tabla — está en el README y
en §2 de este plan.

`d` va en `unixDay` y no en ISO por la misma razón: el cliente ya convierte `unixDay` en cada
registro que decodifica, así que una fecha aquí sería el único sitio del formato que necesita otro
parser.

Costo: 899 bytes para 2 datasets × 6 años (v1: 3 139; el formato original antes de v1: ~5 000).

`version` se verifica en las dos direcciones, y tanto en Go como en TypeScript: una versión que no
es la propia **corta la lectura** en vez de leerse a medias. Más nuevo es obvio — un binario que no
entiende lo publicado no puede sobrescribirlo. Más viejo importa igual y menos obviamente: leerlo
como un índice vacío parece inofensivo porque los años se recalculan, pero cualquier dataset que
*no* se escriba en esa misma corrida desaparecería del índice con sus `.gz` intactos en disco.
Subir de formato es re-sembrar, no adivinar.

`generated` cambia en cada publicación, por eso **nunca** entra en lo que la lambda compara —
la comparación es por `h` de cada año, no por el manifest completo.

---

## 4. La lambda de actualización (Go)

Módulo `updater/`, un solo binario con dos entradas: handler de Lambda si existe
`AWS_LAMBDA_FUNCTION_NAME`, y una corrida única si no (sirve para probar en local y para el modo
GitHub Actions de §4.4).

### 4.1 Ciclo

1. `GET /repos/{owner}/{repo}/contents/docs/manifest.json?ref=main` — los hashes publicados.
2. Lo mismo para los `.gz` de los años que se van a tocar → `binfmt.Gunzip` + `binfmt.Decode`.
3. Traer lo nuevo de la fuente (§4.2).
4. Fusionar por `unixDay` (lo nuevo pisa a lo viejo: SUNAT a veces corrige un día).
5. Agrupar por año → por cada año tocado: `Encode` → `Hash`.
6. **Si todos los hashes coinciden con el manifest → terminar sin commit.** Es el camino normal.
7. Si alguno cambió: `Gzip`, reconstruir `manifest.json`, y un **único commit** con los `.gz`
   cambiados + el manifest (§4.3).

Agrupar por año y regenerar cada año tocado resuelve el 31 de diciembre sin ningún caso especial.

**El estado publicado se lee por la API de GitHub, no por el dominio de Pages.** Pages sirve con
`Cache-Control: max-age=600` (§4.7): una corrida que cayera dentro de esa ventana leería el
manifest anterior, creería que el año cambió y publicaría un commit con exactamente el mismo
árbol. La API de contenidos contesta el commit actual de la rama, siempre.

### 4.2 Fuentes

| fuente | uso | notas |
| --- | --- | --- |
| `https://www.sunat.gob.pe/a/txt/tipoCambio.txt` | autoritativa | `20/09/2026\|3.354\|3.362\|` — **sólo el día de hoy**. Sin rate limit. |
| `https://api.apis.net.pe/v1/tipo-cambio-sunat?month=MM&year=YYYY` | volumen | espejo de la publicación SUNAT; devuelve el mes entero en un JSON. Rate-limitea (429) con ráfagas. |

La lambda pide **el mes corriente completo** al espejo y **hoy** al TXT oficial; si los dos dan
hoy, gana el oficial, y una discrepancia se loguea.

> **Desvío respecto de lo que pediste.** Dijiste "los últimos 2 días". Pedir el mes entero cuesta
> exactamente la misma llamada HTTP y hace el proceso auto-reparable: si la lambda falló tres días
> o SUNAT corrigió una cotización de la semana pasada, la siguiente corrida lo arregla sola en vez
> de dejar un hueco permanente. Con la compuerta del hash no hay ningún commit extra por esto.
> Queda una variable `LOOKBACK_DAYS` para recortarlo a 2 si lo prefieres.

El 429 del espejo se maneja con reintento y backoff — en el backfill hicieron falta 2 pasadas para
69 meses; para 1 mes por corrida es irrelevante, pero el reintento tiene que estar.

### 4.3 Cómo hace commit — **Git Data API, no `git`**

Lo mejor para este caso es la **Git Data API de GitHub** por HTTP plano. Comparada con las otras
dos opciones:

| opción | veredicto |
| --- | --- |
| **Git Data API (REST)** | **Elegida.** ~6 llamadas HTTP, sin working copy, sin binario `git`, sin clonar nada, blobs en base64 (binario seguro), y **un solo commit atómico** con todos los archivos. |
| `go-git` (puro Go) | Funciona en Lambda, pero clona el repo en `/tmp` en cada corrida para escribir 2 KB. Dependencia grande a cambio de nada. |
| `exec.Command("git", ...)` | Descartado: la imagen `provided.al2023` no trae `git`, y el FS es read-only salvo `/tmp`. |

Secuencia:

```
GET    /repos/ivanjoz/public-business-data/git/ref/heads/main        → baseCommitSha
GET    /repos/ivanjoz/public-business-data/git/commits/{baseCommitSha} → baseTreeSha
POST   /repos/ivanjoz/public-business-data/git/blobs                 → blobSha  (uno por archivo, content base64)
POST   /repos/ivanjoz/public-business-data/git/trees                 → treeSha  (base_tree + entries mode 100644)
POST   /repos/ivanjoz/public-business-data/git/commits               → commitSha (parents: [baseCommitSha])
PATCH  /repos/ivanjoz/public-business-data/git/refs/heads/main       → publicado
```

- El `PATCH` **sin `force`**: si la ref se movió entre el primer GET y el PATCH, GitHub rechaza y
  se reintenta la secuencia completa (hasta 3 veces). Nunca se pisa un commit ajeno.
- Mensaje de commit: `data: tipo de cambio SUNAT al 2026-09-20 (2026)` — el año tocado y el último
  día, para que el historial se lea como una bitácora del dato.
- Autor: un nombre fijo tipo `public-business-data bot <bot@un.pe>`.

Se implementa a mano en `updater/github/` (~150 líneas, `net/http` + `encoding/json`, cero
dependencias). `google/go-github` es la alternativa si esto crece, pero para 6 endpoints mete una
dependencia enorme en el binario y el arranque en frío.

### 4.4 Credencial

**PAT fine-grained** con un único permiso — *Contents: Read and write* — y alcance a este único
repositorio, guardado en **SSM Parameter Store como `SecureString`** y leído en el arranque en frío.

Nunca como variable de entorno de la Lambda: ahí queda visible en la consola de Lambda y de
CloudFormation (el mismo motivo por el que `CONFIG` no está en el `template.yml` de genix).

Cuando rotar a mano moleste, el upgrade es una **GitHub App** instalada sólo en este repo: tokens
de instalación de 1 h, firmados con un JWT RS256 desde la clave privada (~40 líneas, `crypto/rsa`,
sin dependencias). No hace falta para v1.

### 4.5 Infraestructura

`updater/cloud/template.yml`, CloudFormation, calcado del patrón de `genix/cloud/template.yml`:

- `AWS::Lambda::Function` — `provided.al2023`, `Handler: bootstrap`, `Architectures: [arm64]`,
  `MemorySize: 128`, `Timeout: 60`. Sin Function URL: nada la invoca desde fuera.
- `AWS::Events::Rule` — `cron(15 0-1,11-23 ? * * *)`: una corrida por hora, de **06:15 a 20:15 de
  Lima**, 15 al día. EventBridge sólo entiende UTC y Lima es UTC−5 todo el año, por eso el rango
  de horas está partido — `0-1,11-23` son 15 horas, no un tramo continuo. Lo que hace que barrer
  la mañana entera no sea un poll agresivo es la **compuerta del hash**: una corrida sin cambios
  son ~4 GET, no commitea y termina en menos de un segundo.
- `AWS::Logs::LogGroup` con `RetentionInDays: 30`.
- Rol con `ssm:GetParameter` + `kms:Decrypt` sobre el parámetro, y nada más.
- El `.zip` se arma con el mismo truco de `genix/cloud/lambda-zip.go` (symlink `bootstrap`).

Coste: ~450 invocaciones/mes de 128 MB y <1 s. El free tier de Lambda es 1 M de peticiones y
400 000 GB·s al mes; esto son ~450 peticiones y ~56 GB·s. Sigue sobrando por varios órdenes de
magnitud, y lo mismo del lado de GitHub: 450 corridas/mes contra un límite de 5 000 llamadas/hora.

> **Alternativa que vale la pena considerar.** Un workflow de GitHub Actions con `schedule:` hace
> lo mismo con **cero infraestructura AWS y cero gestión de credenciales** — el `GITHUB_TOKEN`
> del runner ya puede commitear. El binario Go es el mismo (§4 dice que corre en modo CLI), así que
> no es una implementación distinta, sólo otro disparador. La desventaja es que el cron de Actions
> se retrasa bajo carga y se auto-desactiva a los 60 días de inactividad del repo. Lo dejo escrito
> porque la lambda es más trabajo por una fiabilidad que quizá no necesitas; si sigues queriendo
> la lambda, el plan es §4.1–§4.5 tal cual.

### 4.6 Publicación en Pages

**Settings → Pages → Source: "Deploy from a branch", branch `main`, carpeta `/docs`.**

Con eso el workflow interno `pages-build-deployment` publica en cada push: **no hay que escribir
ningún CI/CD**. El commit de la lambda dispara la publicación por sí solo.

- `docs/CNAME` ya contiene `public-business-data.un.pe`.
- DNS en `un.pe`: registro `CNAME` de `public-business-data` → `ivanjoz.github.io`.
- Marcar *Enforce HTTPS* cuando el certificado esté emitido.
- `.nojekyll` evita que Jekyll procese la carpeta (además de ser más rápido, Jekyll ignora
  archivos y carpetas que empiezan con `_`).

Lo único que sí conviene como Actions es un workflow de **validación** (no de publicación): en cada
push a `docs/`, decodificar cada `.gz` y verificar que el hash y los conteos coinciden con
`manifest.json`. Es `go test ./...` más un comando `verify`.

### 4.7 Cabeceras que GitHub Pages **no** deja controlar

Dos cosas que condicionan el cliente:

1. Pages sirve un `.gz` como `Content-Type: application/gzip` **sin** `Content-Encoding: gzip`, o
   sea que el navegador **no** lo descomprime solo. El cliente descomprime con
   `DecompressionStream('gzip')` — ya verificado contra los archivos reales.
2. `Cache-Control: max-age=600` es fijo. Por eso el cliente cachea por hash del manifest y no
   confía en el caché HTTP.

A cambio, Pages sí manda `Access-Control-Allow-Origin: *`, así que el frontend de genix puede
leerlo cross-origin sin proxy.

---

## 5. Cliente TypeScript

`clients/typescript/`, paquete npm sin dependencias, consumible desde el navegador y desde Node
(ambos tienen `DecompressionStream`).

```
clients/typescript/
├── package.json  tsconfig.json  tsconfig.build.json
├── build.ts                  bun build → un solo .mjs, a dist/ y a docs/
└── src/
    ├── index.ts              API plana + createPublicBusinessData()
    ├── manifest.ts           fetch + caché del manifest, ventana de setCache()
    ├── cache.ts              IndexedDB, con memoria de respaldo
    ├── binfmt.ts             gunzip + DataView — el espejo exacto de updater/binfmt
    ├── exchange-rate.ts      la lógica de negocio del dataset
    └── *.test.ts             46 tests contra los .gz reales de docs/
```

**Se distribuye como un solo archivo.** `bun run build` emite un `.mjs` de 7,8 KB sin
dependencias, a dos sitios desde un mismo build para que no puedan discrepar:

- `docs/client.mjs` — publicado junto a los datos, así que
  `import { getSunatRate } from 'https://public-business-data.un.pe/client.mjs'` funciona sin instalar
  nada, en navegador o en Deno.
- `clients/typescript/dist/client.mjs` — lo que resuelve el `exports` del paquete npm, para los
  bundlers (Vite no resuelve imports por HTTP). Con sus `.d.ts` al lado.

El import es estático y las funciones `async`. **Importar el módulo no hace nada**: la instancia
compartida se construye perezosamente, así que una página que sólo importa el bundle no abre
IndexedDB ni toca la red.

### API

La API plana nombra la fuente en cada función, porque el de SUNAT es un valor contable y no una
cotización de mercado — y así un dataset de la SBS o del BCRP entra como `getSbsRate` /
`getBcrpRate` sin colisionar ni obligar a renombrar nada. Eso es exactamente lo que pasó después
con el BCRP (§11): la familia `getBcrp…` entró sin tocar una sola firma de las de SUNAT.

```ts
await getSunatRate('2026-09-18')         // IExchangeRateDay | null
await getLatestSunatRate()               // el último día publicado
await getSunatRateRange('2024-01-01', '2024-12-31')
await getSunatRateYears(5)               // BULK: los últimos 5 años
await getSunatMonthArrays(2026, 9)       // { buy: number[31], sell: number[31] }
await getSunatLastPublishedDate()        // '2026-09-21', sin bajar ningún año

// La misma familia para el interbancario del BCRP:
await getBcrpRate('2026-09-17')
await getBcrpRateYears(5)

// La clase, para otra baseUrl o varias instancias:
const data = createPublicBusinessData({ baseUrl: 'http://localhost:8080' })
await data.sunatExchangeRate.lastYears(5)
await data.bcrpExchangeRate.lastYears(5)
```

**`getSunatRateYears(yearsAgo)` — la lectura masiva.** Dos decisiones:

- **La ventana se ancla al último día publicado, no al reloj de la máquina.** La respuesta pasa a
  ser una propiedad del dato: reproducible, inmune a un reloj desfasado o a una zona horaria por
  delante de Lima, y no pierde el día que SUNAT publica por adelantado el fin de semana, que un
  `to` de "hoy" cortaría en silencio. El último día sale del manifest, así que averiguarlo no
  cuesta ninguna descarga.
- **Son años completos, no años calendario.** Sobre una serie que acaba el 2026-09-21,
  `getSunatRateYears(5)` va del 2021-09-21 al 2026-09-21 y por tanto toca **seis** archivos. Pedir
  más años de los que existen empieza donde empiece la serie en vez de fallar; pedir menos de 1 sí
  es un error, porque devolver vacío escondería el bug de quien llamó.

Los años que hacen falta se bajan **en paralelo**. Cinco años en serie serían cinco round trips
para traer ocho kilobytes. Como ahora hay cargas concurrentes, `loadYear` deduplica por año: dos
llamadas que se solapen y compartan un año lo descargan una sola vez.

```ts
interface IExchangeRateDay {
  date: string        // '2026-09-18'
  unixDay: number     // 20714
  buy: number         // 3.354   — para mostrar
  sell: number
  buyScaled: number   // 3354    — para almacenar
  sellScaled: number
}
```

Decisiones:

- **`buy` y `buyScaled` a la vez.** Devolver sólo el decimal obligaría a cada consumidor a
  re-escalar para guardar, que es justo donde aparece el error de redondeo. El entero es el dato
  publicado; el decimal es una comodidad de presentación.
- **`monthArrays` devuelve 31 slots con `0` donde no hay cotización** porque ésa es exactamente la
  forma de `DetailBuyRate` / `DetailSellRate` en `finance.ExchangeRate` de genix, con la misma
  escala 1000. La integración de §6 es entonces una asignación, no una conversión.
- **Descarga por año y bajo demanda.** `range('2024-03-01','2024-05-01')` baja sólo `2024.gz`.
- **El caché es IndexedDB (base `public-business-data`), y la ventana se aplica al manifest, no
  a los datos.** `setCache(minutes)` —20 por defecto— dice cada cuánto se vuelve a leer el
  manifest. Los años se guardan bajo la clave `file:{origen}:{path}:{hash}`, o sea que son
  inmutables y no caducan nunca: `2021.gz` no tiene motivo para volver a bajarse. Releer el
  manifest es lo que descubre un hash nuevo, y el hash nuevo es lo que arrastra los bytes nuevos;
  los años cuyo hash ya no aparece se barren solos. Ponerle un reloj a los payloads en vez de al
  manifest re-descargaría toda la historia cada 20 minutos para averiguar que nada se movió.
- **Degrada a memoria sin IndexedDB** (Node, SSR, ventana privada que la deniega), y se prueba
  abriéndola, no comprobando que el global exista: Firefox en privado expone la API y luego se
  niega a abrir.
- **Manifest caducado + red caída = se usa el caducado.** La serie es histórica: un manifest
  viejo responde todo salvo "qué pasó hoy". Sin nada cacheado, en cambio, sí es un error.
- **`binfmt.ts` detecta el magic `0x1f 0x8b`** y sólo descomprime si está. Si algún día Pages,
  Cloudflare o un proxy decodifican el `Content-Encoding` por nosotros, el cliente sigue
  funcionando en vez de romperse con "incorrect header check".
- **Búsqueda binaria sobre el `DataView`**, sin materializar objetos: `at()` y `range()` leen
  directo del buffer. Un año son 359 registros, así que es más una cuestión de no generar basura
  que de velocidad.

---

## 6. Integración en genix

`frontend/routes/finance/exchange-rate/` hoy es un mantenedor manual: un registro por mes con
`DetailBuyRate` / `DetailSellRate` indexados por día y escalados ×1000.

La integración natural es un botón **"Traer de SUNAT"** por mes visible:

```ts
const { buy, sell } = await data.sunatExchangeRate.monthArrays(year, month)
```

y rellenar el `IMonthDraft` con eso, marcándolo `isDirty` para que el usuario revise y guarde. No
hay conversión de escala ni de forma: `monthArrays` ya devuelve la escala y el largo que el draft
espera, y el `0` de "SUNAT no publicó" coincide con el `0` de "no hay cotización" que la página ya
sabe pintar vacío.

Deja el flujo manual intacto — SUNAT pasa a ser una fuente de relleno, no la verdad, que es lo que
corresponde cuando el usuario puede sobrescribir un día.

---

## 7. Estructura final del repositorio

```
public-business-data/
├── PLAN.md                    este archivo
├── config.example.toml        plantilla; config.toml no se versiona
├── deploy.sh                  deploy | token | dry-run | backfill | backfill-bcrp | invoke | logs
├── README.md                  qué es, cómo se consume            [pendiente]
├── AGENTS.md + CLAUDE.md      convenciones                       [pendiente]
├── data/
│   └── tipo-cambio-sunat-usd-pen.json     snapshot fuente (auditoría y re-backfill)
├── docs/                      ← lo que GitHub Pages publica
├── updater/                   ← módulo Go
│   ├── binfmt/                formato binario + gzip + FNV        ✅ 5 tests
│   ├── manifest/              archivo maestro de hashes           ✅
│   ├── config/                config.toml + env + PAT desde SSM   ✅
│   ├── sources/               SUNAT oficial + espejo, y BCRP      ✅ 6 tests
│   ├── github/                cliente Git Data API                ✅
│   ├── publish/               la decisión de commitear o no       ✅ 12 tests
│   ├── cmd/backfill/          siembra docs/: snapshot o API       ✅
│   ├── cmd/updater/           handler Lambda + modo CLI           ✅
│   └── cloud/template.yml     CloudFormation                      ✅
└── clients/typescript/        paquete npm                         ✅ 55 tests
```

---

## 8. Fases

- [x] **F1 — Formato y datos iniciales.** `binfmt` con tests, `manifest`, `cmd/backfill`, los 6
      `.gz` en `docs/`, `CNAME`, `.nojekyll`. Round-trip verificado desde JS contra la fuente.
- [x] **F3 — Cliente TypeScript.** `clients/typescript/` con 15 tests que corren contra los `.gz`
      reales de `docs/`, no contra fixtures. `tsc --noEmit` limpio.
- [x] **F4 — Updater.** `config/`, `sources/`, `github/`, `publish/` (10 tests) y `cmd/updater`
      con doble entrada Lambda/CLI. Dry-run verificado contra las fuentes en vivo.
- [x] **F5 — Infraestructura escrita.** `cloud/template.yml` validado por
      `cloudformation validate-template`, y `deploy.sh`. **Sin desplegar todavía** (ver §10).
- [ ] **F2 — Pages en línea.** Activar Pages (branch `main`, `/docs`), CNAME en el DNS de `un.pe`,
      HTTPS. Comprobar que un `.gz` se descarga y decodifica desde el dominio real.
- [ ] **F5b — Desplegar.** PAT en SSM, `./deploy.sh`, y verificar las dos ramas: corrida sin
      cambios que no commitea, y corrida con un día nuevo que sí publica.
- [ ] **F6 — Endurecer.** Workflow de validación en CI, `docs/index.html`, `README.md`.
- [ ] **F7 — Integrar en genix.** El botón "Traer de SUNAT" de §6.

---

## 10. Qué falta para desplegar

Tres cosas que sólo puedes hacer tú, porque son credenciales o ajustes de cuenta:

1. **Emitir el PAT fine-grained** en GitHub: *Contents: Read and write*, sólo sobre
   `ivanjoz/public-business-data`. Pegarlo en `github.token` de `config.toml` y guardarlo con
   `./deploy.sh token` (lo sube a SSM como SecureString y no vuelve a salir de ahí).
2. **Hacer el primer commit y push** de `docs/`, `updater/` y el resto. Hasta que `docs/` esté en
   `main`, el updater lee 404 y trataría cada año como nuevo.
3. **Activar Pages** — *Settings → Pages → Deploy from a branch → `main` / `/docs`* — y el CNAME
   `public-business-data` → `ivanjoz.github.io` en el DNS de `un.pe`.

Después de eso, `./deploy.sh` compila, sube y crea el stack.

---

## 9. Cosas a tener presentes del dato

- **Cobertura desigual.** 2021: 280 días · 2022: 348 · 2023: 360 · 2024: 359 · 2025: 365 ·
  2026: 264 (hasta el 21-09). La fuente rellena fines de semana en los años recientes y no en los
  antiguos, así que **la serie no tiene un registro por fecha calendario**. Un consumidor que
  necesite continuidad tiene que hacer forward-fill él; el formato no inventa días.
- **`2021-05-13` tiene compra 3.726 > venta 3.725.** Está publicado así por la fuente y no se
  corrigió: `Encode` sólo rechaza cotizaciones ≤ 0. No pude contrastarlo contra una segunda fuente
  independiente — el resto de APIs exigen API key.
- **SUNAT publica el cierre de la SBS del día hábil anterior**, no la cotización del propio día.
- El portal `e-consulta.sunat.gob.pe` está detrás de un WAF con reCAPTCHA y rechaza peticiones
  automatizadas; por eso el volumen histórico viene del espejo y no de ahí.

---

## 11. Segundo dataset — el tipo de cambio de mercado (BCRP)

SUNAT publica un **valor contable**: el promedio del sistema bancario que calcula la SBS, referido
al día hábil anterior. Es lo que pide la norma para facturar, para los libros y para la diferencia
de cambio, y no es a lo que nadie compra dólares. El precio de mercado es otro, y el único que una
API pública del Estado peruano publica es el **interbancario del BCRP**: a lo que los bancos se
compran y se venden dólares entre sí.

| para | qué serie | por qué |
| --- | --- | --- |
| Facturación, libros, diferencia de cambio | SUNAT / SBS | Es la que nombra la norma |
| Seguir el mercado, el dólar mayorista | Interbancario BCRP | Es el precio al que se operó |
| Comprar o vender dólares de verdad | Ninguna | Ese lleva el spread del banco o de la casa de cambio y no se publica |

Por eso son **dos datasets y dos familias de funciones**, no un parámetro de una sola: comparten
el formato binario byte por byte, pero no significan lo mismo, y un `getRate(fuente)` invitaría a
elegir la fuente por descarte en vez de por criterio.

### 11.1 La fuente: BCRPData

```
https://estadisticas.bcrp.gob.pe/estadisticas/series/api/{series}/{formato}/{desde}/{hasta}
```

Sin API key y sin registro. Hasta 10 series por llamada, unidas con guion, así que compra y venta
viajan en un solo request. Series diarias USD/PEN:

| serie | qué es |
| --- | --- |
| `PD04637PD` / `PD04638PD` | **Interbancario compra / venta** — el que se publica aquí |
| `PD04645PD` / `PD04646PD` | Cierre 13:30 compra / venta |
| `PD04639PD` / `PD04640PD` | Sistema bancario SBS — lo que SUNAT republica al día siguiente |

### 11.2 Tres trampas, medidas contra la API en vivo

- **El rango tiene que ir en `YYYY-MM-DD`.** La documentación del BCRP describe una forma año-mes
  (`2026-8`), que es la de las series *mensuales*. Pedida sobre una serie diaria, la API responde
  **200, con el esqueleto de días correcto y todos los valores en `n.d.`** — o la bloquea el WAF.
  Medido en siete intentos espaciados un minuto: seis bloqueados, uno vacío, ninguno con datos;
  los mismos rangos en `YYYY-MM-DD` respondieron con valores siempre. Es el peor fallo posible
  para un proceso desatendido, porque parece exitoso y guardaría una serie vacía.
- **Incapsula responde el challenge con status 200 y cuerpo HTML.** El código de estado no sirve
  como detección: `sources.isChallenge` mira el cuerpo, y el error resultante es reintentable en
  vez de aparecer como "respuesta inesperada" del decodificador JSON. Hace falta además un
  User-Agent de navegador; con el del proyecto el challenge es sistemático.
- **Las fechas son `03.Ago.26`.** Mes abreviado en español —septiembre es `Set`, no `Sep`— y año
  de dos dígitos. El siglo se resuelve contra la ventana pedida y no contra una constante, para
  que un `94` sea 1994 en una petición de los noventa en vez de convertirse en 2094 en silencio.

### 11.3 Precisión y cadencia

El interbancario llega con catorce decimales porque es un promedio ponderado, y el propio `config`
de la respuesta declara la serie con `dec: 3`. Redondear a 3 es fiel a la fuente y encaja con
`binfmt.Scale = 1000` sin tocar el formato. (El cierre 13:30 declara `dec: 4`: si algún día se
publica, o cambia la escala de ese dataset o pierde un decimal. Por eso no está.)

El BCRP publica el interbancario con **un par de días hábiles de retraso**, así que el último día
del dataset va por detrás del de SUNAT — al sembrarlo, SUNAT llegaba al 2026-09-21 y el BCRP al
2026-09-17. No necesita una cadencia propia: cada corrida vuelve a pedir el mes en curso completo,
igual que el espejo de SUNAT, y el hueco se llena solo en la siguiente.

Si el BCRP falla, la corrida **no falla**: se loguea y se publica sólo SUNAT. Lo contrario
retendría un dato que sí llegó por culpa de otro que no.

### 11.4 Lo que cambió en el código

- `sources/bcrp.go` — el fetcher, con las tres trampas de §11.2 resueltas y 6 tests.
- `sources/sources.go` — `get` toma el User-Agent como parámetro, el backoff se comparte en
  `getWithRetry`, y `isChallenge` detecta el HTML del WAF.
- `manifest.NewDataset(key)` reemplaza a `NewExchangeRateDataset()`: una descripción por clave, en
  vez de un constructor por serie.
- `publish.Run` toma `[]Update` en vez de un solo `[]DailyRate`, y las dos series viajan **en un
  único commit**. Partirlo en dos dejaría un instante en el que el manifest publicado nombra el
  hash nuevo de una serie y el viejo de la otra.
- `cmd/backfill` toma `-dataset sunat|bcrp` y **funde** su dataset en el `manifest.json` que ya
  haya en `docs/` en vez de reescribirlo: sembrar el segundo no puede borrar el primero.
- El cliente: `ExchangeRate` es ahora una clase parametrizada por la clave del dataset, con
  `SunatExchangeRate` y `BcrpExchangeRate` encima. Las dos comparten `ManifestStore`, así que una
  página que muestre ambas pide `manifest.json` una sola vez.
- El sitio: selector de serie en la muestra, y la pestaña de integración documenta las dos.

---

## 12. Días provisionales — rellenar la cola sin ensuciar la serie

El retraso del BCRP (§11.3) deja sin dato justo los días por los que más se pregunta. La cola de
la serie se rellena con un tipo de referencia, **marcado**, hasta que llega el real.

### 12.1 Por qué no Yahoo Finance

Fue la primera opción y se descartó **midiéndola**. Sus barras diarias de `PEN=X` contra el
interbancario del propio dataset:

| día | BCRP (medio) | Yahoo | error |
| --- | --- | --- | --- |
| 2026-09-10 | 3,3710 | 3,2497 | −3,6 % |
| 2026-09-14 | 3,3800 | 3,2570 | −3,6 % |
| 2026-09-15 | 3,3755 | 3,2523 | −3,6 % |
| 2026-09-16 | 3,3660 | 3,3560 | −0,3 % |
| 2026-09-17 | 3,3630 | 3,2745 | −2,6 % |

No es un sesgo corregible: oscila sin patrón y además emite barras en domingo. Comprobado en
`query1` y `query2`, con `PEN=X` y con `USDPEN=X`. Su `regularMarketPrice` en vivo sí es
razonable, pero sólo existe para el instante actual y no sirve para rellenar tres días atrás.

La fuente elegida es **`@fawazahmed0/currency-api` por jsDelivr**: sin key, y —lo que decide— con
URL fechada. Medida contra el BCRP en seis días hábiles se queda en **±0,5 % (±1,5 céntimos)**,
consistente. Responde 404 limpio en fechas que no cubre, y su campo `date` confirma la fecha
pedida, que es lo que permite detectar que el CDN resolvió la etiqueta a `latest`.

### 12.2 Las reglas

1. **Sólo donde el BCRP no tiene dato.** En la misma corrida y en las siguientes, el valor real
   gana siempre.
2. **Máximo 3 días hábiles hacia atrás** (`publish.ProvisionalWindow`), contando desde hoy y
   saltando sábados y domingos: el interbancario no opera y rellenar un sábado crearía un día que
   el BCRP no puede confirmar nunca.
3. **Caducan.** Un provisional que el BCRP nunca confirma —un feriado peruano en el que el mercado
   global sí operó— se **borra** al salir de la ventana. Sin esta regla, cada feriado dejaría un
   día aproximado incrustado en la serie para siempre.

El invariante que sale de las tres: **todo día más viejo que la ventana viene de la fuente del
dataset y de nadie más.**

La caducidad se implementa sin estado extra: `Update.Provisional` es *toda* la verdad de cada
corrida, y `mergeYear` empieza borrando lo que el manifest anterior declaraba provisional. Lo que
no se vuelva a entregar, desaparece. Por eso la ventana de consulta al BCRP llega como mínimo 10
días atrás (`cmd/updater`): un provisional del día 1 tiene que seguir dentro del rango que puede
confirmarlo el día 2, aunque haya cambiado el mes.

### 12.3 Dónde vive el flag

En el **manifest**, no en los registros — una sección propia, con los días como `unixDay`:

```jsonc
"provisional": {
  "bcrp-interbancario-usd-pen": [20714]
}
```

Va al nivel de arriba y no dentro del dataset para que una entrada de dataset siga siendo
exactamente "años → archivos" y nada más. La prosa que la acompaña —de dónde sale el relleno y por
qué no sirve para efectos tributarios— la pone el cliente (`PROVISIONAL_DESCRIPTION` en
`descriptions.ts`), igual que el resto de las descripciones que salieron del manifest en v2, así
que `describe().provisional` sigue devolviendo `source`, `sourceUrl`, `note` y `dates` en ISO.

Un byte por registro habría costado el **10 % de cada archivo para siempre** para marcar como
mucho tres días, y habría roto todos los decodificadores escritos contra el formato de 10 bytes.
El manifest lo descarga todo cliente de todas formas, así que la lista viaja gratis. La sección se
omite cuando no hay ninguno, que es el estado normal.

El cliente estampa `provisional: true` al leer, cruzando el payload con esa lista. Se hace ahí y
no dentro de `RateYear` porque las dos cosas se mueven por separado: un día provisional que el
BCRP confirme con exactamente el mismo valor deja el payload —y su hash, y el año cacheado—
intactos mientras el flag desaparece.

### 12.4 Compra y venta

La fuente de referencia cotiza **un solo número**. Los dos que necesita un registro salen de
repartir a su alrededor el **spread mediano de los días reales** de la serie (`MedianSpread` +
`WithSpread`); con spread impar, la milésima suelta va al lado de la venta, que es el que nunca
subestima lo que paga quien compra. Sin días reales que medir, el medio queda a ambos lados en vez
de inventarse una anchura.

### 12.5 Superficie nueva

- `sources.FetchProvisionalMid` — un día de la fuente de referencia; `ErrNotPublished` para el 404.
- `publish.MissingWeekdays` / `MedianSpread` / `WithSpread` / `ProvisionalWindow` — las reglas,
  puras y con tests propios.
- `Update.Provisional`, `DatasetReport.ProvisionalDates`, `manifest.Provisional`.
- Cliente: `IExchangeRateDay.provisional`, `getBcrpLastConfirmedDate()`, y un tercer array
  `provisional: boolean[31]` en `monthArrays` — la forma que se vuelca en una tabla financiera es
  justo donde un valor aproximado llegaría si no como un número más.
- Sitio: la cotización de relleno se pinta en ámbar y en cursiva, con un chip que dice cuántas hay.

---

## 13. Manifest v2 — el índice deja de ser un documento

El formato publicado está en §3. Lo que este apartado guarda es por qué cambió y qué cuesta.

**El problema.** v1 repetía en cada publicación ~600 bytes de prosa por dataset (`title`, `source`,
`sourceUrl`, `unit`, `record`, `scale`, `hashAlgo`) y cinco líneas por año. Nada de eso cambia
salvo cuando cambia este repositorio, y sin embargo lo redescargaba cada visitante en cada fallo de
la ventana de caché. El manifest no es documentación: es el índice que contesta *"¿qué años hay y
cuál se movió?"*.

**El cambio.** Los años cuelgan directo del dataset (`datasets[clave][año]`), cada uno con tres
claves de una letra (`h`, `r`, `d`), y `d` viaja como `unixDay` en vez de ISO. 3 139 → 899 bytes.

**Dónde fue la prosa.** A `clients/typescript/src/descriptions.ts`, que el cliente vuelve a pegar
en `expand()` al cargar el manifest. La API pública no se movió: `describe()` sigue devolviendo
`title`, `unit`, `scale` y `files[año].lastDate` en ISO. Un dataset que el manifest nombre y esa
tabla no tenga recibe una descripción neutra en vez de un error, para que un bundle viejo pueda
listar una serie nueva.

**Migrar es re-sembrar.** `manifest.Unmarshal` y el `expand()` del cliente fallan ante cualquier
versión que no sea la suya, en las dos direcciones (§3), y `cmd/backfill` funde su dataset en el
manifest que encuentra, así que tampoco puede leer el viejo. Para subir la publicación de v1 a v2:
borrar `docs/manifest.json` y sembrar **los dos** datasets —`./deploy.sh backfill` y
`./deploy.sh backfill-bcrp`—, porque el que no se siembre no estará en el índice. Los `.gz` no
cambian (el layout binario es el mismo), así que la única diferencia real del commit es
`manifest.json`.
