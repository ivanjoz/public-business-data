<script lang="ts">
  import DatasetPage from '$lib/DatasetPage.svelte'
  import { datasetPage } from '$lib/datasets'

  // La raíz es el dataset de SUNAT: es el que responde la pregunta que trae a casi todo el
  // mundo aquí —con qué tipo se factura hoy—, así que es el que abre el sitio.
  const dataset = datasetPage('sunat')
</script>

<svelte:head>
  <title>Tipo de Cambio SUNAT · public-business-data</title>
</svelte:head>

<DatasetPage {dataset} />
