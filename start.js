#!/usr/bin/env node
//********************************************************* */
const WEB_SCRIPT = "bun run dev"
const CLIENT_TEST_SCRIPT = "bunx vitest watch --reporter dot"
const GO_CHECK_SCRIPT = "go test ./..."
const WEB_PORT = Number.parseInt(process.env.PBD_PORT || "3573", 10)
//********************************************************* */

const { spawn, execSync } = require("child_process")
const { platform } = require("os")
const path = require("path")
const fs = require("fs")
const isWindows = platform() === "win32"

// Igual que en genix: con doble click no hay consola, así que se reabre dentro de una.
if (!process.stdout.isTTY) {
  if (platform() === "linux") {
    const launcher = path.basename(process.argv[1] || "start.js")
    execSync(`source ~/.profile && source ~/.bashrc && konsole --hold -e "node ${launcher}"`)
  } else {
    console.error("Plataforma no soportada para el arranque sin consola.")
  }
  return
}

// Todas las rutas salen de __dirname y nunca del CWD: el launcher se puede invocar desde
// cualquier carpeta, o con doble click, que abre la terminal en el home.
const webPath = path.join(__dirname, "web")
const clientPath = path.join(__dirname, "clients", "typescript")
const updaterPath = path.join(__dirname, "updater")
const docsPath = path.join(__dirname, "docs")

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
if (!fs.existsSync(path.join(docsPath, "manifest.json"))) {
  console.log("docs/ está sin datos. Sembrando desde data/ con el codificador actual...")
  execSync("go run ./cmd/backfill -source ../data/tipo-cambio-sunat-usd-pen.json -out ../docs", {
    stdio: "inherit", shell: true, cwd: updaterPath,
  })
}

// ─── Procesos ───────────────────────────────────────────────────────────────

const runScript = (script, bar, workingDirectory, environment = {}) => {
  console.log("Ejecutando:", script, "::", path.relative(__dirname, workingDirectory) || ".")

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
