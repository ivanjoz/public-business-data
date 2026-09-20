import type { UiRuntime } from '@genix/ui/runtime'

// El contexto que leen los componentes, armado a mano en vez de con createUiRuntime.
//
// createUiRuntime es el cableado de la aplicación anfitriona: llama a configureExcelRuntime y
// createImageConverter en el ámbito del módulo, así que importarlo arrastra excelize-wasm y tres
// codificadores AVIF — megas de assets que este sitio emitiría y nunca ejecuta. Trae además
// sesiones, un delta cache y un cliente HTTP, y aquí no hay backend: son archivos estáticos.
//
// Lo que los componentes de esta página realmente usan es pequeño: un bag de estado reactivo, un
// traductor y un contador de ids. El resto está para satisfacer el tipo, y lanza si algo lo
// alcanza — mejor que una función que falle en silencio.
const state = $state({
  deviceType: 1,
  mobileMenuOpen: false,
  useTopMinimalMenu: false,
  headerSettingsOpen: false,
  pageTitle: '',
  pageOptions: [],
  pageOptionSelected: 0,
  sideLayerId: 0,
  sideLayerSize: 0,
  popoverId: 0,
  mobileSearchLayer: null,
  mobileDateLayer: null,
  openModalIds: [] as number[],
})

let componentIdCounter = 0

// El paquete escribe los textos como "English|Español". Este sitio es en español.
function translate<Value>(value: Value): Value {
  if (typeof value !== 'string' || !value.includes('|')) return value
  const variants = value.split('|')
  return (variants[1] ?? variants[0]).trim() as Value
}

function absent(member: string): never {
  throw new Error(`public-business-data: el runtime de UI no tiene ${member} — este sitio no tiene backend`)
}

export const uiRuntime = {
  state,
  translate,
  nextComponentId: () => (componentIdCounter += 1),
  makeCdnRoute: (...segments: string[]) => segments.join('/'),
  notify: {
    failure: (message: string) => console.error(message),
    success: (message: string) => console.info(message),
    warning: (message: string) => console.warn(message),
    info: (message: string) => console.info(message),
    confirm: async () => true,
    loading: () => {},
    loadingRemove: () => {},
  },
  searchReferences: new WeakMap(),

  persistFieldValue: () => {},
  readFieldValue: () => null,

  openSideLayer: (id: number) => { state.sideLayerId = id },
  openModal: (id: number) => { state.openModalIds = [...state.openModalIds, id] },
  closeModal: (id: number) => {
    state.openModalIds = state.openModalIds.filter((open) => open !== id)
  },
  closeAllModals: () => { state.openModalIds = [] },

  get http() { return absent('cliente http') },
  get getHandlerRuntime() { return absent('runtime de servicios cacheados') },
  get security() { return absent('runtime de seguridad') },
  get images() { return absent('almacén de imágenes') },
  get imageConverter() { return absent('conversor de imágenes') },
  get fieldPersistence() { return absent('persistencia de campos') },
  get uploads() { return absent('adaptador de subidas') },
  resolveRecord: () => absent('resolvedor de registros'),
} as unknown as UiRuntime
