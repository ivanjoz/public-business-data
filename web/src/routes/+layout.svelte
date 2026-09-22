<script lang="ts">
  import '../app.css'
  import UiProvider from '@genix/ui/runtime/UiProvider.svelte'
  import { uiRuntime } from '$lib/ui-runtime.svelte'
  import { base } from '$app/paths'
  import { page } from '$app/state'
  import { afterNavigate } from '$app/navigation'
  import { getManifestGenerated, setBaseUrl } from '$client'
  import { DATASET_PAGES } from '$lib/datasets'

  const { children } = $props()
  let menuOpen = $state(false)

  let generated = $state<Date | undefined>()

  $effect(() => {
    setBaseUrl(location.origin)
    // Sin catch visible: es un dato de cortesía en la cabecera. Si el manifest no carga, quien
    // lo dice es la página, que es la que no puede hacer su trabajo sin él.
    getManifestGenerated()
      .then((date) => { generated = date })
      .catch(() => {})
  })

  // Hora local de quien mira. El sello del manifest es UTC y el dataset es peruano, pero esto
  // responde a «hace cuánto se actualizó», que se lee contra el reloj de uno.
  const generatedLabel = $derived(
    generated?.toLocaleString('es-PE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
  )

  // Se cierra al navegar y no con un click en cualquier parte del cajón: los enlaces son lo
  // único que hay dentro, y un handler en el contenedor sería un gesto sólo de ratón.
  afterNavigate(() => { menuOpen = false })

  // Una fila por dataset, y cada dataset con su página: la lista sale del registro, así que
  // publicar una serie nueva es añadirla allí y nada más.
  const isCurrent = (href: string) => page.url.pathname === `${base}${href}`
</script>

<UiProvider runtime={uiRuntime}>
  <header class="header">
    <button class="menu-toggle" onclick={() => (menuOpen = !menuOpen)} aria-label="Datasets">
      ☰
    </button>
    <a class="brand" href="{base}/">Data Pública para Negocios</a>
    <span class="head-text">
      <span class="tagline">Datos públicos, como archivos binarios estáticos</span>
      {#if generatedLabel}
        <!-- El título lleva el sello exacto: la línea de la cabecera redondea al minuto. -->
        <span class="updated" title={generated?.toISOString()}>
          Última actualización: {generatedLabel}
        </span>
      {/if}
    </span>
    <span class="spacer"></span>
    <a class="repo" href="https://github.com/ivanjoz/public-business-data" rel="noreferrer">
      <i class="icon-[fa--github]"></i>GitHub
    </a>
  </header>

  <div class="shell">
    <aside class="sidebar" class:is-open={menuOpen}>
      <div class="sidebar-title">DATASETS</div>
      {#each DATASET_PAGES as dataset (dataset.href)}
        <a class="dataset" class:is-current={isCurrent(dataset.href)} href="{base}{dataset.href}">
          <span class="dataset-text">
            <span class="dataset-name">{dataset.name}</span>
            <span class="dataset-detail">{dataset.detail}</span>
          </span>
        </a>
      {/each}
    </aside>
    <main class="workspace">
      {@render children()}
    </main>
  </div>
</UiProvider>

<style>
  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 52px;
    padding: 0 16px;
    background: #4042a3;
    color: #fff;
    position: sticky;
    top: 0;
    z-index: 20;
  }

  .brand {
    font-weight: 600;
    font-size: 17px;
    color: #fff;
    text-decoration: none;
  }

  /* Las dos líneas van apiladas en una columna y no sueltas en la fila: la cabecera centra
     verticalmente a sus hijos, así que sin envoltorio la fecha se pondría al lado del lema en
     vez de debajo. */
  .head-text {
    display: flex;
    flex-direction: column;
    line-height: 1.2;
  }

  .tagline {
    font-size: 13px;
    color: #c8c9ef;
  }

  .updated {
    font-size: 11.5px;
    color: #a3a4e0;
  }

  .spacer { flex: 1; }

  .repo {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    color: #fff;
    text-decoration: none;
    opacity: 0.9;
  }

  .repo:hover { opacity: 1; }

  .menu-toggle {
    display: none;
    background: none;
    border: none;
    color: #fff;
    font-size: 18px;
    cursor: pointer;
    padding: 4px 6px;
  }

  .shell {
    display: flex;
    align-items: flex-start;
    min-height: calc(100vh - 52px);
  }

  .sidebar {
    width: 210px;
    flex-shrink: 0;
    padding: 12px 8px;
    background: #fff;
    border-right: 1px solid #e2e4ef;
    min-height: calc(100vh - 52px);
  }

  .sidebar-title {
    font-size: 11px;
    letter-spacing: 0.08em;
    color: #8b8ba7;
    padding: 4px 8px 10px;
  }

  .dataset {
    display: flex;
    align-items: center;
    padding: 8px;
    border-radius: 6px;
    text-decoration: none;
    color: #2c2b2e;
  }

  .dataset:hover { background: #f1f2fa; }

  .dataset.is-current { background: #eeefff; }

  .dataset-text { display: flex; flex-direction: column; line-height: 1.25; }
  .dataset-name { font-size: 14px; font-weight: 500; }
  .dataset-detail { font-size: 12px; color: #74748c; }

  .workspace {
    flex: 1;
    min-width: 0;
    padding: 12px 14px 0px 14px;
  }

  @media (max-width: 749px) {
    /* Se va el bloque entero, lema y fecha: en móvil la cabecera es para el título y el menú. */
    .head-text { display: none; }
    .menu-toggle { display: inline-block; }

    .sidebar {
      display: none;
      position: absolute;
      top: 52px;
      left: 0;
      z-index: 15;
      width: 240px;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
    }

    .sidebar.is-open { display: block; }
  }
</style>
