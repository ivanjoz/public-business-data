# PLAN — public-business-data

Repositorio de datos públicos de negocio, publicados como archivos binarios comprimidos y
estáticos en GitHub Pages (`https://public-business-data.un.pe`), mantenidos por una lambda en Go
que sólo hace commit cuando el dato realmente cambió.

Primer dataset: **tipo de cambio oficial SUNAT USD/PEN (compra y venta)**.

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
└── sunat-usd-pen/
    ├── 2021.gz  2022.gz  2023.gz  2024.gz  2025.gz  2026.gz
```

`manifest.json` es a la vez el detector de cambios de la lambda y el punto de entrada del cliente:

```jsonc
{
  "version": 1,
  "generated": 1789933819,                       // unix; se mueve en cada publicación
  "datasets": {
    "sunat-usd-pen": {
      "title": "Tipo de cambio oficial SUNAT — dólar estadounidense (compra y venta)",
      "source": "SUNAT — ...", "sourceUrl": "https://www.sunat.gob.pe/a/txt/tipoCambio.txt",
      "unit": "PEN por 1 USD",
      "record": "unixDay:int16, buy:int32, sell:int32 — little endian, 10 bytes",
      "scale": 1000,
      "hashAlgo": "fnv-1a-64",
      "files": {
        "2026": { "hash": "7da90ae37e84eae0", "records": 264, "lastDate": "2026-09-21" }
      }
    }
  }
}
```

El manifest se autodescribe (`record`, `scale`, `unit`): alguien puede decodificar un archivo sin
leer una línea de este repo.

**Cada entrada de año son 3 campos, no 9.** El manifest tiene exactamente dos trabajos —
*"¿cambió el año Y?"* para la lambda y *"¿qué años hay y sigue vigente mi caché?"* para el
cliente — y para ambos basta `hash`. Lo que se quitó y por qué:

| campo | por qué sobraba |
| --- | --- |
| `path` | es `{clave del dataset}/{año}.gz`; la clave del dataset **es** la carpeta y la del año **es** el archivo |
| `bytes` | `records × 10` |
| `gzipBytes` | no lo usa nadie: el cliente no preasigna, descomprime en streaming |
| `firstDay`, `firstDate` | el 1 de enero del año de la clave, salvo el primer año de la serie |
| `lastDay` | lo mismo que `lastDate` en otra unidad; el cliente ya convierte fechas |
| `recordSize`, `endianness` | plegados a la línea `record`, que es prosa para humanos — nadie la parsea |
| `site` | un cliente que acaba de descargar el manifest ya sabe de qué origen vino |

Se quedan `records` y `lastDate` porque son las dos preguntas que se responden **sin descargar el
archivo**: cuánto hay y hasta cuándo llega. Costo total: 1 333 bytes para 6 años (antes 2 637).

`generated` cambia en cada publicación, por eso **nunca** entra en lo que la lambda compara —
la comparación es por `hash` de cada año, no por el manifest completo.

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
- `AWS::Events::Rule` — `cron(0 14,18,22 ? * * *)` (09:00 / 13:00 / 17:00 Lima). SUNAT publica
  temprano; tres intentos cubren el retraso sin ser un poll agresivo. La corrida sin cambios son
  ~3 GET y termina en menos de un segundo.
- `AWS::Logs::LogGroup` con `RetentionInDays: 30`.
- Rol con `ssm:GetParameter` + `kms:Decrypt` sobre el parámetro, y nada más.
- El `.zip` se arma con el mismo truco de `genix/cloud/lambda-zip.go` (symlink `bootstrap`).

Coste: ~90 invocaciones/mes de 128 MB y <1 s. Dentro del free tier por varios órdenes de magnitud.

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

La API plana nombra la fuente en cada función, porque este es el tipo de cambio que publica SUNAT
y no una cotización de mercado — y así un dataset futuro de la SBS o del BCRP entra como
`getSbsRate` / `getBcrpRate` sin colisionar ni obligar a renombrar nada.

```ts
await getSunatRate('2026-09-18')         // IExchangeRateDay | null
await getLatestSunatRate()               // el último día publicado
await getSunatRateRange('2024-01-01', '2024-12-31')
await getSunatRateYears(5)               // BULK: los últimos 5 años
await getSunatMonthArrays(2026, 9)       // { buy: number[31], sell: number[31] }
await getSunatLastPublishedDate()        // '2026-09-21', sin bajar ningún año

// La clase, para otra baseUrl o varias instancias:
const data = createPublicBusinessData({ baseUrl: 'http://localhost:8080' })
await data.sunatExchangeRate.lastYears(5)
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
├── deploy.sh                  deploy | token | dry-run | backfill | invoke | logs
├── README.md                  qué es, cómo se consume            [pendiente]
├── AGENTS.md + CLAUDE.md      convenciones                       [pendiente]
├── data/
│   └── tipo-cambio-sunat-usd-pen.json     snapshot fuente (auditoría y re-backfill)
├── docs/                      ← lo que GitHub Pages publica
├── updater/                   ← módulo Go
│   ├── binfmt/                formato binario + gzip + FNV        ✅ 5 tests
│   ├── manifest/              archivo maestro de hashes           ✅
│   ├── config/                config.toml + env + PAT desde SSM   ✅
│   ├── sources/               SUNAT oficial + espejo mensual      ✅
│   ├── github/                cliente Git Data API                ✅
│   ├── publish/               la decisión de commitear o no       ✅ 10 tests
│   ├── cmd/backfill/          siembra docs/ desde el snapshot     ✅
│   ├── cmd/updater/           handler Lambda + modo CLI           ✅
│   └── cloud/template.yml     CloudFormation                      ✅
└── clients/typescript/        paquete npm                         ✅ 15 tests
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
