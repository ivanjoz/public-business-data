#!/usr/bin/env node
//********************************************************* */
const WEB_SCRIPT = "bun run dev"
const CLIENT_TEST_SCRIPT = "bunx vitest watch --reporter dot"
const GO_CHECK_SCRIPT = "go test ./..."
const WEB_PORT = Number.parseInt(process.env.PBD_PORT || "3573", 10)
//********************************************************* */

import { spawn, execSync } from "node:child_process"
import { platform } from "node:os"
import path from "node:path"
import fs from "node:fs"
const isWindows = platform() === "win32"

// Igual que en genix: con doble click no hay consola, así que se reabre dentro de una.
if (!process.stdout.isTTY) {
  if (platform() === "linux") {
    const launcher = path.basename(process.argv[1] || "start.js")
    execSync(`source ~/.profile && source ~/.bashrc && konsole --hold -e "node ${launcher}"`)
  } else {
    console.error("Plataforma no soportada para el arranque sin consola.")
  }
  // En ESM no hay `return` de nivel superior: el relanzamiento termina aquí igual que antes.
  process.exit(0)
}

// Todas las rutas salen del directorio del script y nunca del CWD: el launcher se puede invocar
// desde cualquier carpeta, o con doble click, que abre la terminal en el home.
const rootPath = import.meta.dirname
const webPath = path.join(rootPath, "web")
const clientPath = path.join(rootPath, "clients", "typescript")
const updaterPath = path.join(rootPath, "updater")
const docsPath = path.join(rootPath, "docs")

const BLUE_BAR = "\x1b[44m \x1b[0m"
const CYAN_BAR = "\x1b[46m \x1b[0m"
const YELLOW_BAR = "\x1b[43m \x1b[0m"

// ─── Dependencias ───────────────────────────────────────────────────────────

// Se comprueba un paquete que de verdad se instala, no la carpeta node_modules: una
// instalación a medias la deja creada y el chequeo pasaría en falso.
const needsInstall = (projectPath, probePackage) =>
  !fs.existsSync(path.join(projectPath, "node_modules", probePackage, "package.json"))

for (const [projectPath, probePackage, label] of [
  [webPath, "vite", "web"],
  [clientPath, "vitest", "clients/typescript"],
]) {
  if (needsInstall(projectPath, probePackage)) {
    console.log(`Instalando dependencias de ${label}...`)
    execSync("bun install", { stdio: "inherit", shell: true, cwd: projectPath })
  }
}

// `go mod download` y no `go mod tidy`: tidy reescribe go.mod/go.sum e invalida la caché de
// compilación de Go en cada arranque, y aquí no hay nada que ordenar.
console.log("Descargando los paquetes de Go (si faltan)...")
execSync("go mod download", { stdio: "inherit", shell: true, cwd: updaterPath })

// ─── Datos ──────────────────────────────────────────────────────────────────

// El dev server sirve docs/ como carpeta de assets, así que sin manifest la página arranca
// vacía y sin decir por qué. Sembrarlo es una orden que ya existe.
const manifestPath = path.join(docsPath, "manifest.json")

// La versión del manifest que escribe esta build: manifest.Version en Go y MANIFEST_VERSION en el
// cliente. Un docs/ de antes del cambio de formato no se lee a medias, se vuelve a sembrar — y
// entero, porque backfill funde un dataset a la vez y el que no se siembre no estaría en el índice.
const MANIFEST_VERSION = 2
let staleFormat = false
if (fs.existsSync(manifestPath)) {
  const published = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version
  if (published !== MANIFEST_VERSION) {
    console.log(`docs/manifest.json es versión ${published} y esta build escribe la ${MANIFEST_VERSION}. Re-sembrando...`)
    fs.rmSync(manifestPath)
    staleFormat = true
  }
}

if (staleFormat || !fs.existsSync(manifestPath)) {
  console.log("docs/ está sin datos. Sembrando desde data/ con el codificador actual...")
  execSync("go run ./cmd/backfill -dataset sunat -source ../data/tipo-cambio-sunat-usd-pen.json -out ../docs", {
    stdio: "inherit", shell: true, cwd: updaterPath,
  })
}

// El BCRP no tiene snapshot en data/ porque su API sí responde el histórico. Se siembra aparte
// para no pedirle nada a una red que puede no estar, y porque el manifest se completa igual:
// backfill funde su dataset en el que ya haya en docs/ en vez de reemplazarlo.
if (staleFormat || !fs.existsSync(path.join(docsPath, "bcrp-interbancario-usd-pen"))) {
  console.log("Falta la serie del BCRP. Pidiéndosela a su API (un año por petición)...")
  execSync("go run ./cmd/backfill -dataset bcrp -from 2021-01-01 -out ../docs", {
    stdio: "inherit", shell: true, cwd: updaterPath,
  })
}

// ─── Procesos ───────────────────────────────────────────────────────────────

const runScript = (script, bar, workingDirectory, environment = {}) => {
  console.log("Ejecutando:", script, "::", path.relative(rootPath, workingDirectory) || ".")

  // workingDirectory va por la opción cwd y no como un `cd` antepuesto: así no hay que citar
  // rutas con espacios ni duplicar el comando por plataforma.
  const options = {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    cwd: workingDirectory,
    env: { ...process.env, ...environment },
  }
  const child = isWindows
    ? spawn(script, [], { ...options, shell: true })
    : spawn("bash", ["-c", script], options)

  const log = (data) => {
    for (const line of data.toString().split("\n").filter((x) => x.trim())) {
      console.log(`${bar} ${line}`)
    }
  }
  child.stdout.on("data", log)
  child.stderr.on("data", log)
  child.on("exit", (code) => log(`Terminó con código ${code}`))
  return child
}

/**
 * Relanza un comando cuando cambia un archivo que importa.
 *
 * Con fs.watch recursivo en vez de nodemon: sería la única dependencia del repo raíz, y
 * habría que crear un package.json y un node_modules sólo para ella. Node trae el watch
 * recursivo en Linux desde la v20.
 */
const watchAndRun = (script, bar, workingDirectory, extensions) => {
  let running = runScript(script, bar, workingDirectory)
  let debounce = null

  fs.watch(workingDirectory, { recursive: true }, (_event, filename) => {
    if (!filename || !extensions.some((extension) => filename.endsWith(extension))) return
    // Un guardado dispara varios eventos, y un `go build` toca la carpeta mientras corre.
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      console.log(`\n${bar} ♻️  ${filename} cambió, relanzando...`)
      running.kill("SIGTERM")
      running = runScript(script, bar, workingDirectory)
    }, 250)
  })
}

const killPortIfInUse = (port) => {
  try {
    const found = isWindows
      ? execSync(`netstat -ano | findstr :${port}`, { encoding: "utf-8" })
      : execSync(`lsof -i :${port} -t`, { encoding: "utf-8" })
    if (!found || !found.trim()) return

    const pids = [
      ...new Set(
        found
          .trim()
          .split("\n")
          .map((line) => (isWindows ? line.trim().split(/\s+/).pop() : line.trim()))
          .filter((pid) => pid && !Number.isNaN(Number(pid))),
      ),
    ]
    if (pids.length === 0) return

    console.log(`El puerto ${port} lo ocupan los PID: ${pids.join(", ")}`)
    for (const pid of pids) {
      try {
        execSync(isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`)
        console.log(`  PID ${pid} terminado.`)
      } catch (error) {
        console.error(`  no se pudo terminar el PID ${pid}: ${error.message}`)
      }
    }
  } catch (error) {
    // lsof y findstr salen con código 1 cuando no hay nada escuchando: eso es lo normal.
  }
}

killPortIfInUse(WEB_PORT)

console.log(
  `\n${YELLOW_BAR}${YELLOW_BAR} Web (vite)   ` +
    `${CYAN_BAR}${CYAN_BAR} Cliente TS (vitest)   ` +
    `${BLUE_BAR}${BLUE_BAR} Updater (go test)\n`,
)

// La web es el único proceso que sirve algo. Los otros dos son la realimentación de las dos
// librerías que el sitio consume: aquí no hay servidor que reiniciar, pero sí un cambio en
// updater/binfmt o en el cliente que tiene que fallar rápido si rompe el formato.
runScript(WEB_SCRIPT, YELLOW_BAR, webPath, { PBD_PORT: String(WEB_PORT) })
runScript(CLIENT_TEST_SCRIPT, CYAN_BAR, clientPath)
watchAndRun(GO_CHECK_SCRIPT, BLUE_BAR, updaterPath, [".go"])

console.log(`\n   Web:       http://localhost:${WEB_PORT}`)
console.log(`   Datos:     http://localhost:${WEB_PORT}/manifest.json`)
console.log(`   Cliente:   http://localhost:${WEB_PORT}/client.mjs\n`)
